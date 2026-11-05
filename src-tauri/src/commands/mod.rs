//! Tauri commands exposed to the WebView.
//!
//! Every backend call is routed through the allow-list in `protocol.rs`, so a
//! compromised renderer cannot reach handshake, shutdown or credential RPCs.
//! Orders additionally pass through a process-wide gate that serialises
//! submissions, rejects identical in-flight payloads and blocks trading while a
//! previous order has an unknown outcome.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::protocol::{
    is_frontend_method, is_order_method, BackendStatus, RpcErrorPayload, ERR_DUPLICATE_REQUEST,
    ERR_EXECUTION_UNKNOWN, ERR_INTERNAL, ERR_INVALID_REQUEST, ERR_UNAVAILABLE,
};
use crate::security::{CredentialField, CredentialSaveResult, SecretStore};
use crate::sidecar::SidecarManager;

static UPDATER_CONFIGURED: AtomicBool = AtomicBool::new(false);

pub fn set_updater_configured(configured: bool) {
    UPDATER_CONFIGURED.store(configured, Ordering::SeqCst);
}

pub struct AppState {
    pub sidecar: Arc<SidecarManager>,
    pub credentials: Arc<SecretStore>,
    pub orders: OrderGate,
    pub data_dir: PathBuf,
}

// ── Order safety gate ───────────────────────────────────────────────────────

pub struct OrderGate {
    lock: tokio::sync::Mutex<()>,
    uncertain: AtomicBool,
    inflight: Arc<Mutex<HashSet<String>>>,
    state_file: PathBuf,
}

pub struct OrderTicket {
    set: Arc<Mutex<HashSet<String>>>,
    key: String,
}

impl Drop for OrderTicket {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.key);
    }
}

impl OrderGate {
    /// `state_file` persists the "unknown execution" flag so a crash or a
    /// restart cannot silently re-enable order submission.
    pub fn new(state_file: PathBuf) -> Self {
        let uncertain = std::fs::read_to_string(&state_file)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.get("uncertain").and_then(Value::as_bool))
            .unwrap_or(false);
        if uncertain {
            log::warn!(
                "Order submission stays blocked: a previous order has an unknown execution status ({}).",
                state_file.display()
            );
        }
        Self {
            lock: tokio::sync::Mutex::new(()),
            uncertain: AtomicBool::new(uncertain),
            inflight: Arc::new(Mutex::new(HashSet::new())),
            state_file,
        }
    }

    async fn acquire(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, RpcErrorPayload> {
        if self.uncertain.load(Ordering::SeqCst) {
            return Err(self.uncertain_error());
        }
        let guard = self.lock.lock().await;
        if self.uncertain.load(Ordering::SeqCst) {
            return Err(self.uncertain_error());
        }
        Ok(guard)
    }

    fn begin(&self, key: &str) -> Result<OrderTicket, RpcErrorPayload> {
        let mut inflight = self.inflight.lock().unwrap();
        if !inflight.insert(key.to_string()) {
            return Err(RpcErrorPayload::new(
                ERR_DUPLICATE_REQUEST,
                "An identical order is already being submitted. Wait for the result before retrying.",
            ));
        }
        Ok(OrderTicket {
            set: self.inflight.clone(),
            key: key.to_string(),
        })
    }

    pub fn mark_uncertain(&self) {
        self.uncertain.store(true, Ordering::SeqCst);
        self.persist(true);
    }

    pub fn acknowledge(&self) {
        self.uncertain.store(false, Ordering::SeqCst);
        self.persist(false);
    }

    fn persist(&self, uncertain: bool) {
        let payload = json!({ "uncertain": uncertain });
        let tmp = self.state_file.with_extension("json.tmp");
        let write = || -> std::io::Result<()> {
            std::fs::write(&tmp, serde_json::to_vec_pretty(&payload)?)?;
            std::fs::rename(&tmp, &self.state_file)
        };
        if let Err(error) = write() {
            log::error!(
                "Cannot persist order-uncertain state to {}: {error}",
                self.state_file.display()
            );
            let _ = std::fs::remove_file(&tmp);
        }
    }

    pub fn is_uncertain(&self) -> bool {
        self.uncertain.load(Ordering::SeqCst)
    }

    fn uncertain_error(&self) -> RpcErrorPayload {
        RpcErrorPayload::new(
            ERR_EXECUTION_UNKNOWN,
            "A previous order has an unknown execution status. Verify open orders on the exchange, then re-enable trading.",
        )
        .with_data(json!({
            "retryable": false,
            "reconcile": "account.open_orders",
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_state_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tradepanel-orders-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("trading_state.json")
    }

    #[tokio::test]
    async fn uncertain_state_survives_restart_until_acknowledged() {
        let path = temp_state_path();
        let gate = OrderGate::new(path.clone());
        assert!(!gate.is_uncertain());
        gate.mark_uncertain();
        assert!(gate.is_uncertain());
        assert!(gate.acquire().await.is_err());

        let restarted = OrderGate::new(path.clone());
        assert!(
            restarted.is_uncertain(),
            "a restart must not silently re-enable order submission"
        );
        restarted.acknowledge();
        assert!(!restarted.is_uncertain());
        assert!(!OrderGate::new(path.clone()).is_uncertain());
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn identical_inflight_orders_are_rejected() {
        let gate = OrderGate::new(temp_state_path());
        let ticket = gate.begin("place:{\"coin\":\"BTC\"}").unwrap();
        let error = match gate.begin("place:{\"coin\":\"BTC\"}") {
            Err(error) => error,
            Ok(_) => panic!("duplicate submission must be rejected"),
        };
        assert_eq!(error.code, ERR_DUPLICATE_REQUEST);
        drop(ticket);
        assert!(gate.begin("place:{\"coin\":\"BTC\"}").is_ok());
    }

    #[tokio::test]
    async fn gate_serialises_submissions() {
        let gate = std::sync::Arc::new(OrderGate::new(temp_state_path()));
        let first = gate.acquire().await.unwrap();
        let worker_gate = gate.clone();
        let second = tokio::spawn(async move {
            let _guard = worker_gate.acquire().await.unwrap();
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!second.is_finished(), "second submission must wait");
        drop(first);
        second.await.unwrap();
    }
}

// ── Backend proxying ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn backend_status(state: State<'_, AppState>) -> Result<BackendStatus, RpcErrorPayload> {
    Ok(state.sidecar.status())
}

#[tauri::command]
pub async fn backend_restart(state: State<'_, AppState>) -> Result<(), RpcErrorPayload> {
    state.sidecar.restart().await
}

#[tauri::command]
pub async fn backend_rpc(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, RpcErrorPayload> {
    if !is_frontend_method(&method) {
        return Err(RpcErrorPayload::new(
            ERR_INVALID_REQUEST,
            format!("Method not allowed: {method}"),
        ));
    }
    let params = match params.unwrap_or_else(|| json!({})) {
        Value::Object(map) => Value::Object(map),
        _ => {
            return Err(RpcErrorPayload::new(
                ERR_INVALID_REQUEST,
                "params must be a JSON object",
            ))
        }
    };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000));

    if is_order_method(&method) {
        let _gate = state.orders.acquire().await?;
        let key = format!(
            "{method}:{}",
            serde_json::to_string(&params).unwrap_or_default()
        );
        let ticket = state.orders.begin(&key)?;
        let outcome = state.sidecar.request(&method, params, timeout).await;
        if matches!(&outcome, Err(error) if error.code == ERR_EXECUTION_UNKNOWN) {
            state.orders.mark_uncertain();
            log::error!("Order outcome unknown; further submissions blocked until acknowledged");
        }
        drop(ticket);
        return outcome;
    }

    state.sidecar.request(&method, params, timeout).await
}

#[tauri::command]
pub async fn orders_acknowledge(state: State<'_, AppState>) -> Result<(), RpcErrorPayload> {
    state.orders.acknowledge();
    log::warn!("User acknowledged an uncertain order state; trading re-enabled");
    Ok(())
}

#[tauri::command]
pub async fn orders_state(state: State<'_, AppState>) -> Result<Value, RpcErrorPayload> {
    Ok(json!({ "uncertain": state.orders.is_uncertain() }))
}

// ── Credentials (OS keyring) ────────────────────────────────────────────────

#[tauri::command]
pub async fn credentials_status(
    state: State<'_, AppState>,
) -> Result<Vec<CredentialField>, RpcErrorPayload> {
    let store = state.credentials.clone();
    match tauri::async_runtime::spawn_blocking(move || store.status()).await {
        Ok(Ok(fields)) => Ok(fields),
        Ok(Err(error)) => Err(RpcErrorPayload::new(ERR_UNAVAILABLE, error)),
        Err(error) => Err(RpcErrorPayload::new(
            ERR_INTERNAL,
            format!("Credential task failed: {error}"),
        )),
    }
}

#[tauri::command]
pub async fn credentials_save(
    app: AppHandle,
    state: State<'_, AppState>,
    values: HashMap<String, String>,
    clear: Option<Vec<String>>,
) -> Result<CredentialSaveResult, RpcErrorPayload> {
    let clear = clear.unwrap_or_default();
    let store = state.credentials.clone();
    let values_for_store = values.clone();
    let clear_for_store = clear.clone();
    let saved = match tauri::async_runtime::spawn_blocking(move || {
        store.save(&values_for_store, &clear_for_store)
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            return Err(RpcErrorPayload::new(ERR_UNAVAILABLE, error));
        }
        Err(error) => {
            return Err(RpcErrorPayload::new(
                ERR_INTERNAL,
                format!("Credential task failed: {error}"),
            ))
        }
    };

    if let Err(error) = state.sidecar.set_credentials(values, clear).await {
        log::warn!(
            "Credentials stored but not applied to the running backend: {}",
            error.message
        );
        crate::events::emit_notice(
            &app,
            "warn",
            "Credentials were saved to the OS keyring but the backend could not apply them. Restart the backend.",
        );
    }
    Ok(saved)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyCredentials {
    pub found: bool,
    pub path: Option<String>,
    pub keys: Vec<String>,
}

pub fn find_legacy_env() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("TRADEPANEL_LEGACY_ENV") {
        let path = PathBuf::from(value);
        return path.is_file().then_some(path);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("keys").join(".env"));
        candidates.push(cwd.join("..").join("keys").join(".env"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("keys").join(".env"));
        }
    }
    if cfg!(debug_assertions) {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("keys")
                .join(".env"),
        );
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[tauri::command]
pub async fn credentials_legacy_status() -> Result<LegacyCredentials, RpcErrorPayload> {
    match find_legacy_env() {
        Some(path) => {
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let keys = text
                .lines()
                .filter_map(|line| line.split_once('='))
                .map(|(key, _)| key.trim().trim_start_matches("export ").to_string())
                .filter(|key| key == "HL_PRIVATE_KEY" || key == "HL_ADDRESS")
                .collect();
            Ok(LegacyCredentials {
                found: true,
                path: Some(path.to_string_lossy().to_string()),
                keys,
            })
        }
        None => Ok(LegacyCredentials {
            found: false,
            path: None,
            keys: Vec::new(),
        }),
    }
}

/// Imports legacy plaintext credentials into the OS keyring after an explicit
/// user action. The source file is left untouched so the user stays in control.
#[tauri::command]
pub async fn credentials_import_legacy(
    state: State<'_, AppState>,
) -> Result<CredentialSaveResult, RpcErrorPayload> {
    let Some(path) = find_legacy_env() else {
        return Err(RpcErrorPayload::new(
            ERR_UNAVAILABLE,
            "No legacy keys/.env file was found",
        ));
    };
    let store = state.credentials.clone();
    let imported = tauri::async_runtime::spawn_blocking(move || {
        let count = store.import_legacy_env(&path);
        (count, store.status())
    })
    .await
    .map_err(|error| {
        RpcErrorPayload::new(ERR_INTERNAL, format!("Credential task failed: {error}"))
    })?;

    let (count, fields) = match imported {
        (count, Ok(fields)) => (count, fields),
        (_, Err(error)) => return Err(RpcErrorPayload::new(ERR_UNAVAILABLE, error)),
    };
    if count == 0 {
        return Err(RpcErrorPayload::new(
            ERR_UNAVAILABLE,
            "No importable credentials were found in the legacy file",
        ));
    }
    // Apply the imported values to the running sidecar.
    let keys: Vec<String> = fields
        .iter()
        .filter(|field| field.set)
        .map(|field| field.key.clone())
        .collect();
    let values = load_values(&state.credentials, &keys);
    if let Err(error) = state.sidecar.set_credentials(values, Vec::new()).await {
        log::warn!(
            "Imported credentials could not be applied live: {}",
            error.message
        );
    }
    Ok(CredentialSaveResult { keys, fields })
}

fn load_values(store: &SecretStore, keys: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for key in keys {
        if let Ok(Some(value)) = store.get(key) {
            out.insert(key.clone(), value.to_string());
        }
    }
    out
}

// ── Shell integration ───────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub protocol_version: u32,
    pub data_dir: String,
}

#[tauri::command]
pub async fn app_info(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppInfo, RpcErrorPayload> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        protocol_version: crate::protocol::PROTOCOL_VERSION,
        data_dir: state.data_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn open_trade_page(coin: String) -> Result<(), RpcErrorPayload> {
    let coin = coin.trim();
    if coin.is_empty() || coin.len() > 20 || !coin.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        return Err(RpcErrorPayload::new(ERR_INVALID_REQUEST, "Invalid coin"));
    }
    let url = format!("https://app.hyperliquid.xyz/trade/{coin}");
    open::that(url).map_err(|error| {
        RpcErrorPayload::new(ERR_INTERNAL, format!("Cannot open the browser: {error}"))
    })
}

#[tauri::command]
pub async fn set_fullscreen(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window
        .set_fullscreen(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn log_frontend(level: Option<String>, message: String) {
    let message: String = message.chars().take(2000).collect();
    match level.as_deref() {
        Some("error") => log::error!(target: "frontend", "{message}"),
        Some("warn") => log::warn!(target: "frontend", "{message}"),
        _ => log::info!(target: "frontend", "{message}"),
    }
}

// ── Updates ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub current_version: Option<String>,
}

fn updates_unavailable() -> RpcErrorPayload {
    RpcErrorPayload::new(
        ERR_UNAVAILABLE,
        "Updates are not configured for this build: no signing public key was provided at build time (TRADEPANEL_UPDATER_PUBKEY).",
    )
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, RpcErrorPayload> {
    if !UPDATER_CONFIGURED.load(Ordering::SeqCst) {
        return Err(updates_unavailable());
    }
    let updater = app
        .updater()
        .map_err(|error| RpcErrorPayload::new(ERR_UNAVAILABLE, error.to_string()))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            current_version: Some(update.current_version.clone()),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            version: None,
            notes: None,
            current_version: Some(app.package_info().version.to_string()),
        }),
        Err(error) => Err(RpcErrorPayload::new(
            ERR_UNAVAILABLE,
            format!("Update check failed: {error}"),
        )),
    }
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), RpcErrorPayload> {
    if !UPDATER_CONFIGURED.load(Ordering::SeqCst) {
        return Err(updates_unavailable());
    }
    let updater = app
        .updater()
        .map_err(|error| RpcErrorPayload::new(ERR_UNAVAILABLE, error.to_string()))?;
    let update = updater
        .check()
        .await
        .map_err(|error| {
            RpcErrorPayload::new(ERR_UNAVAILABLE, format!("Update check failed: {error}"))
        })?
        .ok_or_else(|| RpcErrorPayload::new(ERR_UNAVAILABLE, "No update is available"))?;

    update
        .download_and_install(|_chunk: usize, _total: Option<u64>| {}, || {})
        .await
        .map_err(|error| {
            RpcErrorPayload::new(
                ERR_UNAVAILABLE,
                format!("Update installation failed (signature check or download): {error}"),
            )
        })?;
    log::info!("Update installed; restarting");
    app.restart();
}

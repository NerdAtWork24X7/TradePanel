//! Provider sign-in and the model catalogue, served by the bundled Pi runtime.
//!
//! The agent itself is driven over JSONL RPC (see `manager.rs`). Pi's *auth*
//! runtime is not exposed over RPC, so this module supervises a second tiny
//! Node process (`settings-service.mjs`) that imports `ModelRuntime` from the
//! same bundled package. It is the same design Pi Scope uses for its Settings →
//! Authentication page: the provider list, OAuth/device-code flows, API-key
//! prompts and the models a credential unlocks all come from Pi, not from a
//! hard-coded table in the host.
//!
//! Credentials live in `<agent dir>/auth.json` (0600), Pi's own file. The
//! analysis process therefore needs no API key in its environment, and the
//! WebView never receives a stored secret — only booleans, masked status labels
//! and the short-lived prompt the user is answering.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::protocol::RpcErrorPayload;

use super::lines::{read_bounded_line, ReadLine, MAX_LINE_BYTES};
use super::paths::AiPaths;
use super::runtime::AiRuntime;
use super::spawn;

pub const AI_AUTH_EVENT: &str = "ai:auth";
pub const ERR_AI_AUTH: i64 = -32023;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_AUTH_FILE_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethod {
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    pub can_login: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProvider {
    pub id: String,
    pub name: String,
    pub methods: Vec<AuthMethod>,
    pub configured: bool,
    #[serde(rename = "usingOAuth")]
    pub using_oauth: bool,
    pub status_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthCredential {
    pub provider_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthProviders {
    pub ready: bool,
    #[serde(default)]
    pub reason: Option<String>,
    pub providers: Vec<AuthProvider>,
    pub credentials: Vec<AuthCredential>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub id: String,
    pub provider_id: String,
    pub provider_name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    #[serde(default)]
    pub prompt: Option<Value>,
    #[serde(default)]
    pub events: Vec<Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub input: Vec<String>,
    #[serde(default)]
    pub thinking_levels: Option<Vec<String>>,
    #[serde(default)]
    pub cost: Option<Value>,
}

struct Pending {
    sender: oneshot::Sender<Result<Value, String>>,
}

pub struct AuthService {
    app: AppHandle,
    /// Swapped in place by an in-app Pi update; every spawn clones a snapshot.
    runtime: RwLock<Result<AiRuntime, String>>,
    paths: AiPaths,
    child: AsyncMutex<Option<Child>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Pending>>,
    sessions: Mutex<HashMap<String, AuthSession>>,
    next_id: AtomicU64,
    started: AtomicBool,
    updating: AtomicBool,
    start_lock: AsyncMutex<()>,
    self_ref: OnceLock<Weak<Self>>,
}

impl AuthService {
    pub fn new(app: AppHandle, runtime: Result<AiRuntime, String>, paths: AiPaths) -> Self {
        Self {
            app,
            runtime: RwLock::new(runtime),
            paths,
            child: AsyncMutex::new(None),
            stdin: AsyncMutex::new(None),
            pending: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            started: AtomicBool::new(false),
            updating: AtomicBool::new(false),
            start_lock: AsyncMutex::new(()),
            self_ref: OnceLock::new(),
        }
    }

    /// Bind the service to its owning Arc so the reader task can reach it
    /// without an unsafe pointer or a reference cycle.
    pub fn bind(self: &Arc<Self>) {
        let _ = self.self_ref.set(Arc::downgrade(self));
    }

    fn arc(&self) -> Option<Arc<Self>> {
        self.self_ref.get().and_then(Weak::upgrade)
    }

    /// Is the bridge available at all? (False for a staged runtime that predates
    /// it; the analysis panel still works.)
    pub fn available(&self) -> bool {
        self.runtime
            .read()
            .unwrap()
            .as_ref()
            .ok()
            .and_then(|runtime| runtime.settings_service.as_ref())
            .is_some()
    }

    pub fn unavailable_reason(&self) -> Option<String> {
        let runtime = self.runtime.read().unwrap();
        match runtime.as_ref() {
            Err(error) => Some(error.clone()),
            Ok(runtime) if runtime.settings_service.is_none() => Some(
                "This AI runtime has no provider settings service. Rebuild it with \
                 `node backend/scripts/build-ai-runtime.mjs`."
                    .to_string(),
            ),
            Ok(_) => None,
        }
    }

    /// Refuse new settings-service spawns while an update replaces the tree.
    pub fn set_updating(&self, value: bool) {
        self.updating.store(value, Ordering::SeqCst);
    }

    /// Activate a runtime discovered after an in-app Pi update. The settings
    /// child is stopped first so the next request resolves the new package tree
    /// (and so Windows can release its file handles).
    pub async fn replace_runtime(&self, runtime: Result<AiRuntime, String>) {
        self.stop().await;
        *self.runtime.write().unwrap() = runtime;
    }

    async fn ensure_started(&self) -> Result<(), RpcErrorPayload> {
        if self.updating.load(Ordering::SeqCst) {
            return Err(RpcErrorPayload::new(
                ERR_AI_AUTH,
                "The AI runtime is being updated. Try again when the update finishes.",
            ));
        }
        if self.started.load(Ordering::SeqCst) {
            return Ok(());
        }
        let _guard = self.start_lock.lock().await;
        if self.started.load(Ordering::SeqCst) {
            return Ok(());
        }
        let runtime = self
            .runtime
            .read()
            .unwrap()
            .clone()
            .map_err(|error| RpcErrorPayload::new(ERR_AI_AUTH, error))?;
        let mut child = spawn::auth_command(&runtime, &self.paths)
            .map_err(|error| RpcErrorPayload::new(ERR_AI_AUTH, error))?
            .spawn()
            .map_err(|error| {
                RpcErrorPayload::new(
                    ERR_AI_AUTH,
                    format!("Cannot start the settings service: {error}"),
                )
            })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            RpcErrorPayload::new(
                ERR_AI_AUTH,
                "The settings service did not provide a stdin pipe",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            RpcErrorPayload::new(
                ERR_AI_AUTH,
                "The settings service did not provide a stdout pipe",
            )
        })?;
        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::info!(target: "ai-auth", "{}", line);
                }
            });
        }
        *self.child.lock().await = Some(child);
        *self.stdin.lock().await = Some(stdin);
        self.started.store(true, Ordering::SeqCst);
        let owner = self.arc().ok_or_else(|| {
            RpcErrorPayload::new(ERR_AI_AUTH, "The settings service is not initialised")
        })?;
        Self::spawn_reader(owner, stdout);
        log::info!("Started AI provider settings service");
        Ok(())
    }

    fn spawn_reader(service: Arc<Self>, stdout: tokio::process::ChildStdout) {
        let app = service.app.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            let mut buffer = Vec::with_capacity(8 * 1024);
            loop {
                match read_bounded_line(&mut reader, &mut buffer, MAX_LINE_BYTES).await {
                    Ok(ReadLine::Line) => {
                        if buffer.is_empty() {
                            continue;
                        }
                        let line = String::from_utf8_lossy(&buffer);
                        let Ok(message) = serde_json::from_str::<Value>(&line) else {
                            log::warn!(target: "ai-auth", "discarding malformed frame");
                            continue;
                        };
                        match message.get("type").and_then(Value::as_str) {
                            Some("response") => {
                                let Some(id) = message.get("id").and_then(Value::as_str) else {
                                    continue;
                                };
                                let pending = service.pending.lock().unwrap().remove(id);
                                if let Some(pending) = pending {
                                    let result = if message.get("ok").and_then(Value::as_bool)
                                        == Some(true)
                                    {
                                        Ok(message.get("data").cloned().unwrap_or(Value::Null))
                                    } else {
                                        Err(message
                                            .get("error")
                                            .and_then(Value::as_str)
                                            .unwrap_or("settings service error")
                                            .to_string())
                                    };
                                    let _ = pending.sender.send(result);
                                }
                            }
                            Some("auth_state") => {
                                if let Some(session) = message.get("session") {
                                    if let Ok(parsed) =
                                        serde_json::from_value::<AuthSession>(session.clone())
                                    {
                                        service
                                            .sessions
                                            .lock()
                                            .unwrap()
                                            .insert(parsed.id.clone(), parsed.clone());
                                        let _ =
                                            app.emit(AI_AUTH_EVENT, json!({ "session": parsed }));
                                    }
                                }
                            }
                            Some("ready") => {
                                log::info!(
                                    target: "ai-auth",
                                    "Settings service ready ({} / pi {})",
                                    message.get("node").and_then(Value::as_str).unwrap_or("node"),
                                    message.get("pi").and_then(Value::as_str).unwrap_or("pi")
                                );
                            }
                            _ => {}
                        }
                    }
                    Ok(ReadLine::Eof) => break,
                    Ok(ReadLine::Oversized) => {
                        log::warn!(target: "ai-auth", "settings service frame exceeded the limit");
                    }
                    Err(error) => {
                        log::warn!(target: "ai-auth", "settings service read failed: {error}");
                        break;
                    }
                }
            }
            service_on_eof(&service);
        });
    }

    async fn request(&self, message: Value, timeout: Duration) -> Result<Value, RpcErrorPayload> {
        self.ensure_started().await?;
        let id = self.next_id.fetch_add(1, Ordering::SeqCst).to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(id.clone(), Pending { sender });
        let mut payload = message;
        payload["id"] = Value::String(id.clone());
        let line = serde_json::to_vec(&payload).map_err(internal)?;
        {
            let mut guard = self.stdin.lock().await;
            let Some(stdin) = guard.as_mut() else {
                self.pending.lock().unwrap().remove(&id);
                return Err(RpcErrorPayload::new(
                    ERR_AI_AUTH,
                    "The settings service is not running",
                ));
            };
            tokio::time::timeout(Duration::from_secs(10), async {
                stdin.write_all(&line).await?;
                stdin.write_all(b"\n").await?;
                stdin.flush().await
            })
            .await
            .map_err(|_| {
                RpcErrorPayload::new(
                    ERR_AI_AUTH,
                    "The settings service did not accept the request",
                )
            })?
            .map_err(|error| {
                RpcErrorPayload::new(
                    ERR_AI_AUTH,
                    format!("Cannot write to the settings service: {error}"),
                )
            })?;
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(Ok(data))) => Ok(data),
            Ok(Ok(Err(error))) => Err(RpcErrorPayload::new(ERR_AI_AUTH, error)),
            Ok(Err(_)) => Err(RpcErrorPayload::new(
                ERR_AI_AUTH,
                "The settings service stopped",
            )),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(RpcErrorPayload::new(
                    ERR_AI_AUTH,
                    "The provider did not answer in time. Check the network or try again.",
                ))
            }
        }
    }

    pub async fn providers(&self) -> Result<AuthProviders, RpcErrorPayload> {
        let data = self
            .request(json!({ "type": "providers" }), REQUEST_TIMEOUT)
            .await?;
        serde_json::from_value(data).map_err(|error| {
            RpcErrorPayload::new(ERR_AI_AUTH, format!("Invalid provider catalogue: {error}"))
        })
    }

    pub async fn models(&self) -> Result<Vec<AuthModel>, RpcErrorPayload> {
        let data = self
            .request(json!({ "type": "models" }), REQUEST_TIMEOUT)
            .await?;
        serde_json::from_value(data).map_err(|error| {
            RpcErrorPayload::new(ERR_AI_AUTH, format!("Invalid model catalogue: {error}"))
        })
    }

    pub async fn login_start(
        &self,
        provider: &str,
        auth_type: &str,
    ) -> Result<AuthSession, RpcErrorPayload> {
        let data = self
            .request(
                json!({ "type": "login_start", "providerId": provider, "authType": auth_type }),
                LOGIN_TIMEOUT,
            )
            .await?;
        self.parse_session(data)
    }

    pub async fn login_answer(
        &self,
        session_id: &str,
        prompt_id: u32,
        value: &str,
    ) -> Result<AuthSession, RpcErrorPayload> {
        let data = self
            .request(
                json!({
                    "type": "login_answer",
                    "sessionId": session_id,
                    "promptId": prompt_id,
                    "value": value,
                }),
                REQUEST_TIMEOUT,
            )
            .await?;
        self.parse_session(data)
    }

    pub async fn login_cancel(&self, session_id: &str) -> Result<AuthSession, RpcErrorPayload> {
        let data = self
            .request(
                json!({ "type": "login_cancel", "sessionId": session_id }),
                REQUEST_TIMEOUT,
            )
            .await?;
        self.parse_session(data)
    }

    pub async fn login_get(&self, session_id: &str) -> Result<AuthSession, RpcErrorPayload> {
        if let Some(session) = self.sessions.lock().unwrap().get(session_id).cloned() {
            return Ok(session);
        }
        let data = self
            .request(
                json!({ "type": "login_get", "sessionId": session_id }),
                REQUEST_TIMEOUT,
            )
            .await?;
        self.parse_session(data)
    }

    pub async fn logout(&self, provider: &str) -> Result<AuthProviders, RpcErrorPayload> {
        let data = self
            .request(
                json!({ "type": "logout", "providerId": provider }),
                REQUEST_TIMEOUT,
            )
            .await?;
        serde_json::from_value(data).map_err(|error| {
            RpcErrorPayload::new(ERR_AI_AUTH, format!("Invalid provider catalogue: {error}"))
        })
    }

    /// Wait until a running login settles. Used by the one-field API-key flow;
    /// OAuth uses the push-event + poll path in the UI.
    pub async fn wait_login(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> Result<AuthSession, RpcErrorPayload> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let session = self.login_get(session_id).await?;
            if session.status != "running" {
                return Ok(session);
            }
            if tokio::time::Instant::now() >= deadline {
                let _ = self.login_cancel(session_id).await;
                return Err(RpcErrorPayload::new(
                    ERR_AI_AUTH,
                    "Provider sign-in timed out",
                ));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    fn parse_session(&self, data: Value) -> Result<AuthSession, RpcErrorPayload> {
        let session: AuthSession = serde_json::from_value(data).map_err(|error| {
            RpcErrorPayload::new(ERR_AI_AUTH, format!("Invalid login state: {error}"))
        })?;
        self.sessions
            .lock()
            .unwrap()
            .insert(session.id.clone(), session.clone());
        Ok(session)
    }

    pub async fn stop(&self) {
        let mut stdin = self.stdin.lock().await.take();
        if let Some(stdin) = stdin.as_mut() {
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                stdin.write_all(b"{\"type\":\"shutdown\"}\n").await?;
                stdin.flush().await
            })
            .await;
        }
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
        }
        self.started.store(false, Ordering::SeqCst);
        self.fail_all("The settings service stopped");
    }

    fn fail_all(&self, message: &str) {
        let mut pending = self.pending.lock().unwrap();
        for (_, entry) in pending.drain() {
            let _ = entry.sender.send(Err(message.to_string()));
        }
    }
}

/// Called when the reader reaches EOF. The service may be respawned on the next
/// request; pending calls fail rather than hanging.
fn service_on_eof(service: &AuthService) {
    service.started.store(false, Ordering::SeqCst);
    service.fail_all("The settings service stopped");
}

fn internal(error: impl std::fmt::Display) -> RpcErrorPayload {
    RpcErrorPayload::new(ERR_AI_AUTH, format!("Provider settings failed: {error}"))
}

/// True when Pi's own auth file holds a credential for `provider`. This is a
/// cheap status read used by `AiManager`; it never exposes the secret.
pub fn has_credential(paths: &AiPaths, provider: &str) -> bool {
    let path = paths.agent.join("auth.json");
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > 0 && meta.len() <= MAX_AUTH_FILE_BYTES => {}
        _ => return false,
    }
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    value
        .get(provider)
        .map(|entry| entry.is_object())
        .unwrap_or(false)
}

/// Permission check shared with `paths.rs` (the file is created by Pi, so make
/// sure a fresh login lands owner-only even on platforms with a permissive umask).
pub fn restrict_auth_file(paths: &AiPaths) {
    let path = paths.agent.join("auth.json");
    if path.is_file() {
        super::paths::restrict(&path, 0o600);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn paths(root: PathBuf) -> AiPaths {
        AiPaths {
            root: root.clone(),
            agent: root.join("agent"),
            sessions: root.join("sessions"),
            workspace: root.join("workspace"),
            context_file: root.join("context.json"),
            settings_file: root.join("settings.json"),
            conversations_file: root.join("conversations.json"),
        }
    }

    #[test]
    fn credential_detection_reads_pi_auth_file() {
        let root = std::env::temp_dir().join(format!("tp-auth-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("agent")).unwrap();
        let paths = paths(root.clone());
        fs::write(
            paths.agent.join("auth.json"),
            r#"{"openai":{"type":"api_key","key":"sk-secret"}}"#,
        )
        .unwrap();
        assert!(has_credential(&paths, "openai"));
        assert!(!has_credential(&paths, "anthropic"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn malformed_or_oversized_auth_file_is_not_configured() {
        let root = std::env::temp_dir().join(format!("tp-auth-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("agent")).unwrap();
        let paths = paths(root.clone());
        fs::write(paths.agent.join("auth.json"), "{not json").unwrap();
        assert!(!has_credential(&paths, "openai"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn auth_session_deserializes() {
        let session: AuthSession = serde_json::from_value(json!({
            "id": "s1",
            "providerId": "openai",
            "providerName": "OpenAI",
            "type": "api_key",
            "status": "running",
            "prompt": { "id": 1, "type": "secret", "message": "Enter OpenAI API key" },
            "events": [],
            "startedAt": 1
        }))
        .unwrap();
        assert_eq!(session.kind, "api_key");
        assert_eq!(session.prompt.unwrap()["type"], "secret");
    }
}

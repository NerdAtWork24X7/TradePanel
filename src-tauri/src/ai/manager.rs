//! Supervised Pi runtime.
//!
//! One lazily started child process per application, restarted with bounded
//! backoff after a crash. Every frame is validated and size-capped; only the
//! five read-only analysis tools are declared to the model. Trading never waits
//! on this process.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::protocol::{RpcErrorPayload, ERR_INTERNAL, ERR_UNAVAILABLE, MAX_MESSAGE_BYTES};
use crate::security::SecretStore;

use super::auth::{self, AuthProviders, AuthService, ERR_AI_AUTH};
use super::context;
use super::lines::{read_bounded_line, ReadLine};
use super::paths::AiPaths;
use super::probe::{self, ModelInfo};
use super::runtime::AiRuntime;
use super::spawn::{self, Launch};
use super::store::{
    now_ms, validate_model, validate_provider, AiSettings, AiStore, ConversationStore,
    THINKING_LEVELS,
};

pub const AI_EVENT: &str = "ai:event";
pub const AI_STATUS_EVENT: &str = "ai:status";

const ERR_AI_NOT_CONFIGURED: i64 = -32020;
const ERR_AI_BUSY: i64 = -32021;
const ERR_AI_RUNTIME: i64 = -32022;

const START_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_WAIT: Duration = Duration::from_secs(5);
const HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_FAILURE_LIMIT: u32 = 2;
const MAX_RESTARTS: u32 = 5;
const MAX_API_KEY_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub state: String,
    pub message: Option<String>,
    pub pid: Option<u32>,
    pub runtime_ready: bool,
    pub runtime_error: Option<String>,
    pub node_version: Option<String>,
    pub pi_version: Option<String>,
    pub configured: bool,
    pub has_key: bool,
    pub provider: Option<String>,
    pub provider_label: Option<String>,
    pub model: Option<String>,
    pub thinking: String,
    pub portfolio_context: bool,
    pub session_id: Option<String>,
    pub streaming: bool,
    pub attempt: u32,
    pub models: usize,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub models: Vec<ModelInfo>,
    pub model: String,
    pub reply: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub runtime_ready: bool,
    pub runtime_error: Option<String>,
    pub runtime_root: Option<String>,
    pub node_version: Option<String>,
    pub pi_version: Option<String>,
    pub target: Option<String>,
    pub node_path: Option<String>,
    pub pi_cli: Option<String>,
    pub extension: Option<String>,
    pub system_prompt: Option<String>,
    pub agent_dir: String,
    pub sessions_dir: String,
    pub workspace_dir: String,
    pub context_file: String,
    pub session_files: usize,
    pub last_error: Option<String>,
    pub auth_ready: bool,
    pub auth_error: Option<String>,
}

struct Pending {
    command: String,
    sender: oneshot::Sender<Result<Value, RpcErrorPayload>>,
}

#[derive(Default)]
struct RunState {
    state: String,
    message: Option<String>,
    pid: Option<u32>,
    attempt: u32,
    last_error: Option<String>,
}

pub struct AiManager {
    app: AppHandle,
    paths: AiPaths,
    store: Arc<AiStore>,
    credentials: Arc<SecretStore>,
    auth: Arc<AuthService>,
    /// Swapped in place by an in-app Pi update; never mutated while a child
    /// process is being spawned from it (each call clones the snapshot).
    runtime: RwLock<Result<AiRuntime, String>>,
    child: AsyncMutex<Option<Child>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Pending>>,
    state: Mutex<RunState>,
    session: Mutex<Option<String>>,
    models: Mutex<Vec<ModelInfo>>,
    next_id: AtomicU64,
    generation: AtomicU64,
    spawn_lock: AsyncMutex<()>,
    send_lock: AsyncMutex<()>,
    ready: AtomicBool,
    has_key: AtomicBool,
    streaming: AtomicBool,
    /// Set while an in-app Pi update replaces the runtime tree.
    updating: AtomicBool,
    shutting_down: AtomicBool,
    restart_attempts: AtomicU32,
    health_failures: AtomicU32,
    self_ref: OnceLock<Weak<Self>>,
}

impl AiManager {
    pub fn new(
        app: AppHandle,
        paths: AiPaths,
        store: Arc<AiStore>,
        credentials: Arc<SecretStore>,
        auth: Arc<AuthService>,
        runtime: Result<AiRuntime, String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            app,
            paths,
            store,
            credentials,
            auth,
            runtime: RwLock::new(runtime),
            child: AsyncMutex::new(None),
            stdin: AsyncMutex::new(None),
            pending: Mutex::new(HashMap::new()),
            state: Mutex::new(RunState {
                state: "stopped".to_string(),
                ..RunState::default()
            }),
            session: Mutex::new(None),
            models: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
            generation: AtomicU64::new(0),
            spawn_lock: AsyncMutex::new(()),
            send_lock: AsyncMutex::new(()),
            ready: AtomicBool::new(false),
            has_key: AtomicBool::new(false),
            streaming: AtomicBool::new(false),
            updating: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            restart_attempts: AtomicU32::new(0),
            health_failures: AtomicU32::new(0),
            self_ref: OnceLock::new(),
        })
    }

    /// Snapshot of the active runtime. Cloning keeps an update swap from
    /// changing paths under a process that is already starting.
    pub fn runtime(&self) -> Result<AiRuntime, String> {
        self.runtime.read().unwrap().clone()
    }

    /// Install a newly discovered runtime (used by the in-app Pi update).
    pub fn set_runtime(&self, runtime: Result<AiRuntime, String>) {
        *self.runtime.write().unwrap() = runtime;
    }

    /// Refuse new spawns while an update replaces the files they would run.
    pub fn set_updating(&self, value: bool) {
        self.updating.store(value, Ordering::SeqCst);
    }

    /// Bind the manager to its owning Arc so reader tasks can keep a weak
    /// reference without a reference cycle.
    pub fn bind(self: &Arc<Self>) {
        let _ = self.self_ref.set(Arc::downgrade(self));
    }

    fn arc(&self) -> Result<Arc<Self>, RpcErrorPayload> {
        self.self_ref
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| RpcErrorPayload::new(ERR_INTERNAL, "AI manager is not initialised"))
    }

    /// Background work: probe key presence once and start the health monitor.
    /// Deliberately does not spawn Pi; analysis is lazy.
    pub fn start_background(self: &Arc<Self>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            this.refresh_key_state().await;
            this.emit_status();
        });
        Self::monitor(self.clone());
    }

    pub fn status(&self) -> AiStatus {
        let settings = self.store.settings();
        let run = self.state.lock().unwrap();
        let streaming = self.streaming.load(Ordering::SeqCst);
        let has_key = self.has_key.load(Ordering::SeqCst);
        let runtime_state = self.runtime.read().unwrap().clone();
        let runtime = runtime_state.as_ref().ok();
        let configured = runtime.is_some()
            && has_key
            && !settings.provider.is_empty()
            && !settings.model.is_empty();
        AiStatus {
            state: run.state.clone(),
            message: run.message.clone(),
            pid: run.pid,
            runtime_ready: runtime.is_some(),
            runtime_error: runtime_state.as_ref().err().cloned(),
            node_version: runtime.map(|runtime| runtime.node_version.clone()),
            pi_version: runtime.map(|runtime| runtime.pi_version.clone()),
            configured,
            has_key,
            provider: (!settings.provider.is_empty()).then(|| settings.provider.clone()),
            provider_label: (!settings.provider.is_empty())
                .then(|| provider_name(&settings.provider)),
            model: (!settings.model.is_empty()).then(|| settings.model.clone()),
            thinking: settings.thinking.clone(),
            portfolio_context: settings.portfolio_context,
            session_id: self.session.lock().unwrap().clone(),
            streaming,
            attempt: run.attempt,
            models: self.models.lock().unwrap().len(),
            updated_at_ms: now_ms(),
        }
    }

    pub async fn status_fresh(&self) -> AiStatus {
        self.refresh_key_state().await;
        self.status()
    }

    pub fn diagnostics(&self) -> Diagnostics {
        let runtime_state = self.runtime.read().unwrap().clone();
        let runtime = runtime_state.as_ref().ok();
        let last_error = self.state.lock().unwrap().last_error.clone();
        Diagnostics {
            runtime_ready: runtime.is_some(),
            runtime_error: runtime_state.as_ref().err().cloned(),
            runtime_root: runtime.map(|runtime| runtime.root.to_string_lossy().into_owned()),
            node_version: runtime.map(|runtime| runtime.node_version.clone()),
            pi_version: runtime.map(|runtime| runtime.pi_version.clone()),
            target: runtime.map(|runtime| runtime.target.clone()),
            node_path: runtime.map(|runtime| runtime.node.to_string_lossy().into_owned()),
            pi_cli: runtime.map(|runtime| runtime.pi_cli.to_string_lossy().into_owned()),
            extension: runtime.map(|runtime| runtime.extension.to_string_lossy().into_owned()),
            system_prompt: runtime
                .map(|runtime| runtime.system_prompt.to_string_lossy().into_owned()),
            agent_dir: self.paths.agent.to_string_lossy().into_owned(),
            sessions_dir: self.paths.sessions.to_string_lossy().into_owned(),
            workspace_dir: self.paths.workspace.to_string_lossy().into_owned(),
            context_file: self.paths.context_file.to_string_lossy().into_owned(),
            session_files: count_jsonl(&self.paths.sessions),
            last_error,
            auth_ready: self.auth.available(),
            auth_error: self.auth.unavailable_reason(),
        }
    }

    /// Provider catalogue straight from Pi's runtime (OAuth + API-key methods).
    pub async fn providers(&self) -> Result<AuthProviders, RpcErrorPayload> {
        self.auth.providers().await
    }

    // ── Settings / keyring ────────────────────────────────────────────────

    pub(crate) async fn refresh_key_state(&self) {
        let provider = self.store.settings().provider;
        if provider.is_empty() {
            self.has_key.store(false, Ordering::SeqCst);
            return;
        }
        if self.dev_key(&provider).is_some() || auth::has_credential(&self.paths, &provider) {
            self.has_key.store(true, Ordering::SeqCst);
            return;
        }
        // Legacy keyring entries (created before provider auth moved to Pi's
        // auth.json) keep working; the next sign-in writes auth.json.
        let credentials = self.credentials.clone();
        let key = ai_key_name(&provider);
        let present = tauri::async_runtime::spawn_blocking(move || {
            matches!(credentials.get_external(&key), Ok(Some(_)))
        })
        .await
        .unwrap_or(false);
        self.has_key.store(present, Ordering::SeqCst);
    }

    pub fn auth(&self) -> Arc<AuthService> {
        self.auth.clone()
    }

    fn provider_key(&self, provider: &str) -> Result<String, String> {
        if let Some(key) = self.dev_key(provider) {
            return Ok(key);
        }
        // Pi reads auth.json itself. An empty key means "do not inject one";
        // the credential is already there (API key or refreshed OAuth token).
        if auth::has_credential(&self.paths, provider) {
            return Ok(String::new());
        }
        let key = ai_key_name(provider);
        match self.credentials.get_external(&key) {
            Ok(Some(value)) => Ok(value.to_string()),
            Ok(None) => Err(format!(
                "No credentials are stored for {} ({}). Open AI settings and sign in.",
                provider_name(provider),
                provider
            )),
            Err(error) => Err(format!("The OS credential store is unavailable: {error}")),
        }
    }

    #[cfg(debug_assertions)]
    fn dev_key(&self, provider: &str) -> Option<String> {
        let expected = std::env::var("TRADEPANEL_AI_DEV_PROVIDER").ok()?;
        let key = std::env::var("TRADEPANEL_AI_DEV_KEY").ok()?;
        (expected == provider && !key.trim().is_empty()).then_some(key)
    }

    #[cfg(not(debug_assertions))]
    fn dev_key(&self, _provider: &str) -> Option<String> {
        None
    }

    pub async fn connect(
        &self,
        provider: String,
        api_key: String,
        model: Option<String>,
        thinking: Option<String>,
        portfolio_context: Option<bool>,
    ) -> Result<ConnectResult, RpcErrorPayload> {
        validate_provider(&provider).map_err(invalid)?;
        if let Some(model) = model.as_deref().filter(|value| !value.trim().is_empty()) {
            validate_model(model).map_err(invalid)?;
        }
        let runtime = self
            .runtime()
            .map_err(|error| RpcErrorPayload::new(ERR_AI_RUNTIME, error))?;
        if self.updating.load(Ordering::SeqCst) {
            return Err(RpcErrorPayload::unavailable(
                "The AI runtime is being updated. Try again when the update finishes.",
            ));
        }
        if self.streaming.load(Ordering::SeqCst) {
            return Err(busy());
        }
        let catalogue = self.auth.providers().await?;
        let supported = catalogue.providers.iter().any(|entry| entry.id == provider);
        if !supported {
            return Err(invalid(format!("Unsupported provider: {provider}")));
        }

        let api_key = api_key.trim().to_string();
        if !api_key.is_empty()
            && (api_key.len() > MAX_API_KEY_BYTES || api_key.chars().any(char::is_control))
        {
            return Err(invalid("Enter a valid API key"));
        }

        // The probe needs a clean process; the next prompt restarts with the
        // resulting configuration.
        self.stop_process().await;

        if !api_key.is_empty() {
            if !catalogue
                .providers
                .iter()
                .find(|entry| entry.id == provider)
                .map(|entry| {
                    entry
                        .methods
                        .iter()
                        .any(|method| method.kind == "api_key" && method.can_login)
                })
                .unwrap_or(false)
            {
                return Err(invalid(format!(
                    "{} does not offer an API key sign-in. Use account sign-in instead.",
                    provider_name(&provider)
                )));
            }
            let mut session = self.auth.login_start(&provider, "api_key").await?;
            // Pi's API-key flows ask for the key as their first (usually only)
            // prompt. Wait briefly in case the provider emits it asynchronously.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while session.prompt.is_none()
                && session.status == "running"
                && tokio::time::Instant::now() < deadline
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
                session = self.auth.login_get(&session.id).await?;
            }
            let prompt = session.prompt.clone().ok_or_else(|| {
                RpcErrorPayload::new(
                    ERR_AI_AUTH,
                    format!(
                        "{} needs an interactive sign-in. Open AI settings and use Sign in.",
                        provider_name(&provider)
                    ),
                )
            })?;
            let kind = prompt.get("type").and_then(Value::as_str).unwrap_or("text");
            let prompt_id = prompt
                .get("id")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| RpcErrorPayload::new(ERR_AI_AUTH, "Invalid sign-in prompt"))?;
            if kind != "secret" && kind != "text" {
                let _ = self.auth.login_cancel(&session.id).await;
                return Err(RpcErrorPayload::new(
                    ERR_AI_AUTH,
                    format!(
                        "{} asks for more than an API key. Open AI settings and use Sign in.",
                        provider_name(&provider)
                    ),
                ));
            }
            self.auth
                .login_answer(&session.id, prompt_id, &api_key)
                .await?;
            let settled = self
                .auth
                .wait_login(&session.id, Duration::from_secs(90))
                .await?;
            if settled.status != "ok" {
                return Err(RpcErrorPayload::new(
                    ERR_AI_AUTH,
                    settled
                        .error
                        .unwrap_or_else(|| "Provider sign-in did not complete.".into()),
                ));
            }
        } else if !auth::has_credential(&self.paths, &provider) {
            return Err(RpcErrorPayload::new(
                ERR_AI_NOT_CONFIGURED,
                format!(
                    "Sign in to {} before saving preferences.",
                    provider_name(&provider)
                ),
            ));
        }
        auth::restrict_auth_file(&self.paths);

        let outcome = probe::probe(&runtime, &self.paths, &provider, "", model.as_deref())
            .await
            .map_err(|error| {
                self.set_error(format!("Provider check failed: {error}"));
                RpcErrorPayload::new(ERR_AI_RUNTIME, error)
            })?;

        let previous = self.store.settings();
        let thinking = thinking
            .filter(|value| THINKING_LEVELS.contains(&value.as_str()))
            .unwrap_or(previous.thinking);
        let settings = AiSettings {
            provider: provider.clone(),
            model: outcome.model.clone(),
            thinking,
            portfolio_context: portfolio_context.unwrap_or(previous.portfolio_context),
        };
        if let Err(error) = self.store.save_settings(settings) {
            return Err(RpcErrorPayload::new(ERR_INTERNAL, error));
        }
        *self.models.lock().unwrap() = outcome.models.clone();
        self.has_key.store(true, Ordering::SeqCst);
        self.set_status(
            "stopped",
            Some("Provider connected. Start an analysis when ready.".into()),
        );
        self.emit_status();
        Ok(ConnectResult {
            models: outcome.models,
            model: outcome.model,
            reply: outcome.reply,
        })
    }

    pub async fn disconnect(&self) -> Result<(), RpcErrorPayload> {
        if self.streaming.load(Ordering::SeqCst) {
            return Err(busy());
        }
        self.stop_process().await;
        let settings = self.store.settings();
        if !settings.provider.is_empty() {
            let _ = self.auth.logout(&settings.provider).await;
            let credentials = self.credentials.clone();
            let key_name = ai_key_name(&settings.provider);
            let _ = tauri::async_runtime::spawn_blocking(move || {
                credentials.delete_external(&key_name)
            })
            .await;
        }
        let next = AiSettings {
            provider: String::new(),
            model: String::new(),
            thinking: settings.thinking,
            portfolio_context: settings.portfolio_context,
        };
        self.store.save_settings(next).map_err(internal)?;
        self.models.lock().unwrap().clear();
        self.has_key.store(false, Ordering::SeqCst);
        self.set_status("stopped", Some("Provider disconnected.".into()));
        self.emit_status();
        Ok(())
    }

    pub async fn save_preferences(
        &self,
        provider: Option<String>,
        model: Option<String>,
        thinking: Option<String>,
        portfolio_context: Option<bool>,
    ) -> Result<AiSettings, RpcErrorPayload> {
        let current = self.store.settings();
        let mut next = current.clone();
        if let Some(provider) = provider {
            let provider = provider.trim().to_string();
            if !provider.is_empty() {
                validate_provider(&provider).map_err(invalid)?;
            }
            next.provider = provider;
        }
        if let Some(model) = model {
            let model = model.trim().to_string();
            if !model.is_empty() {
                validate_model(&model).map_err(invalid)?;
            }
            next.model = model;
        }
        if let Some(thinking) = thinking {
            if !THINKING_LEVELS.contains(&thinking.as_str()) {
                return Err(invalid("Invalid thinking level"));
            }
            next.thinking = thinking;
        }
        if let Some(enabled) = portfolio_context {
            next.portfolio_context = enabled;
        }
        let saved = self.store.save_settings(next).map_err(internal)?;
        if saved.provider != current.provider
            || saved.model != current.model
            || saved.thinking != current.thinking
        {
            self.stop_process().await;
        }
        self.refresh_key_state().await;
        self.emit_status();
        Ok(saved)
    }

    pub async fn refresh_models(&self) -> Result<Vec<ModelInfo>, RpcErrorPayload> {
        let settings = self.store.settings();
        if settings.provider.is_empty() {
            return Err(not_configured());
        }
        let all = self.auth.models().await?;
        let models: Vec<ModelInfo> = all
            .into_iter()
            .filter(|model| model.provider == settings.provider)
            .map(|model| ModelInfo {
                id: model.id,
                name: model.name,
                provider: model.provider,
                context_window: model.context_window,
                max_tokens: model.max_tokens,
                reasoning: model.reasoning,
                input: model.input,
            })
            .collect();
        if models.is_empty() {
            return Err(RpcErrorPayload::new(
                ERR_AI_RUNTIME,
                format!(
                    "No models are available for {}. Check the provider account or sign in again.",
                    provider_name(&settings.provider)
                ),
            ));
        }
        *self.models.lock().unwrap() = models.clone();
        self.emit_status();
        Ok(models)
    }

    // ── Conversations ─────────────────────────────────────────────────────

    pub fn conversations(&self) -> ConversationStore {
        self.store.conversations()
    }

    pub async fn create_conversation(&self) -> Result<ConversationStore, RpcErrorPayload> {
        self.store.create(Some("New analysis")).map_err(internal)?;
        self.stop_process().await;
        Ok(self.store.conversations())
    }

    pub async fn activate_conversation(
        &self,
        id: &str,
    ) -> Result<ConversationStore, RpcErrorPayload> {
        if self.streaming.load(Ordering::SeqCst) {
            return Err(busy());
        }
        self.store.activate(id).map_err(invalid)?;
        self.stop_process().await;
        Ok(self.store.conversations())
    }

    pub async fn rename_conversation(
        &self,
        id: &str,
        title: &str,
    ) -> Result<ConversationStore, RpcErrorPayload> {
        self.store.rename(id, title).map_err(invalid)?;
        Ok(self.store.conversations())
    }

    pub async fn delete_conversation(
        &self,
        id: &str,
    ) -> Result<ConversationStore, RpcErrorPayload> {
        if self.streaming.load(Ordering::SeqCst) {
            return Err(busy());
        }
        let active = self.store.conversations().active;
        let store = self.store.delete(id).map_err(invalid)?;
        self.paths.delete_session_files(id);
        if active == id {
            self.stop_process().await;
        }
        Ok(store)
    }

    /// Cached history, read from Pi's session file without starting Pi.
    pub async fn history(&self) -> Result<Value, RpcErrorPayload> {
        let conversation = self.store.active().ok_or_else(not_configured)?;
        let messages = self.paths.read_session_messages(&conversation.id, 240);
        Ok(json!({
            "conversationId": conversation.id,
            "messages": messages,
            "cached": true,
        }))
    }

    // ── Prompting ─────────────────────────────────────────────────────────

    pub async fn send(
        &self,
        message: &str,
        snapshot: &Value,
        images: &[String],
    ) -> Result<Value, RpcErrorPayload> {
        if !self.has_key.load(Ordering::SeqCst) {
            self.refresh_key_state().await;
        }
        let message = message.trim();
        if message.is_empty() || message.chars().count() > 20_000 {
            return Err(invalid("Message must be between 1 and 20000 characters"));
        }
        if self.streaming.load(Ordering::SeqCst) {
            return Err(busy());
        }
        let status = self.status();
        if !status.runtime_ready {
            return Err(RpcErrorPayload::new(
                ERR_AI_RUNTIME,
                status
                    .runtime_error
                    .unwrap_or_else(|| "The AI runtime is unavailable".into()),
            ));
        }
        if !status.configured {
            return Err(not_configured());
        }
        let images = context::validate_images(images).map_err(invalid)?;
        let conversation = match self.store.active() {
            Some(conversation) => conversation,
            None => self.store.create(Some("New analysis")).map_err(internal)?,
        };
        context::write_snapshot(&self.paths.context_file, snapshot).map_err(invalid)?;

        let _guard = self.send_lock.lock().await;
        if self.streaming.load(Ordering::SeqCst) {
            return Err(busy());
        }
        self.ensure_ready(Some(conversation.id.clone())).await?;

        let mut payload = json!({ "message": message });
        if !images.is_empty() {
            payload["images"] = Value::Array(images.iter().map(|image| image.to_wire()).collect());
        }
        let data = self.request("prompt", payload, REQUEST_TIMEOUT).await?;
        let disposition = data
            .get("disposition")
            .and_then(Value::as_str)
            .unwrap_or("started")
            .to_string();
        if disposition == "handled" {
            return Err(RpcErrorPayload::new(
                ERR_AI_RUNTIME,
                "The prompt was handled without starting an analysis. Try again.",
            ));
        }
        let settings = self.store.settings();
        let model = format!("{}/{}", settings.provider, settings.model);
        let auto_title: String = message.chars().take(60).collect();
        self.store
            .touch(&conversation.id, &model, Some(&auto_title));
        self.emit_event(json!({
            "type": "user_message",
            "conversationId": conversation.id,
            "text": message,
            "images": images.len(),
            "capturedAtMs": snapshot.get("capturedAtMs").cloned().unwrap_or(Value::Null),
        }));
        Ok(json!({
            "conversationId": conversation.id,
            "disposition": disposition,
            "images": images.len(),
        }))
    }

    pub async fn abort(&self) -> Result<(), RpcErrorPayload> {
        if !self.ready.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.request("abort", json!({}), Duration::from_secs(20))
            .await
            .map(|_| ())
    }

    pub async fn stop(&self) -> Result<(), RpcErrorPayload> {
        if self.streaming.load(Ordering::SeqCst) {
            let _ = self.abort().await;
        }
        self.stop_process().await;
        self.set_status("stopped", Some("AI runtime stopped.".into()));
        Ok(())
    }

    // ── Process lifecycle ─────────────────────────────────────────────────

    async fn ensure_ready(&self, session_id: Option<String>) -> Result<(), RpcErrorPayload> {
        if self.ready.load(Ordering::SeqCst) {
            let current = self.session.lock().unwrap().clone();
            if current == session_id {
                return Ok(());
            }
        }
        self.spawn_locked(session_id).await
    }

    async fn spawn_locked(&self, session_id: Option<String>) -> Result<(), RpcErrorPayload> {
        let owner = self.arc()?;
        let _guard = self.spawn_lock.lock().await;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(RpcErrorPayload::unavailable("Application is shutting down"));
        }
        if self.updating.load(Ordering::SeqCst) {
            return Err(RpcErrorPayload::unavailable(
                "The AI runtime is being updated. Try again when the update finishes.",
            ));
        }
        if self.ready.load(Ordering::SeqCst) && self.session.lock().unwrap().clone() == session_id {
            return Ok(());
        }
        let runtime = self
            .runtime()
            .map_err(|error| RpcErrorPayload::new(ERR_AI_RUNTIME, error))?;
        let settings = self.store.settings();
        if settings.provider.is_empty() || settings.model.is_empty() {
            return Err(not_configured());
        }
        let key = self
            .provider_key(&settings.provider)
            .map_err(|error| RpcErrorPayload::new(ERR_AI_NOT_CONFIGURED, error))?;

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.ready.store(false, Ordering::SeqCst);
        self.streaming.store(false, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
        }
        *self.stdin.lock().await = None;
        self.fail_pending("AI runtime is restarting", ERR_UNAVAILABLE);

        let launch = Launch {
            runtime: &runtime,
            paths: &self.paths,
            provider: &settings.provider,
            model: &settings.model,
            thinking: &settings.thinking,
            session_id: session_id.as_deref(),
            system_prompt: None,
        };
        let mut child = spawn::command(&launch, &key).spawn().map_err(|error| {
            self.set_error(format!("Cannot start the AI runtime: {error}"));
            RpcErrorPayload::new(
                ERR_AI_RUNTIME,
                format!("Cannot start the bundled AI runtime: {error}"),
            )
        })?;
        let pid = child.id().unwrap_or(0);
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| {
            RpcErrorPayload::new(ERR_AI_RUNTIME, "AI runtime did not provide a stdout pipe")
        })?;
        let stderr = child.stderr.take();
        *self.child.lock().await = Some(child);
        *self.stdin.lock().await = stdin;
        *self.session.lock().unwrap() = session_id.clone();
        {
            let mut run = self.state.lock().unwrap();
            run.state = "starting".into();
            run.message = Some("Starting AI runtime…".into());
            run.pid = Some(pid);
        }
        self.emit_status();
        log::info!("Started AI runtime (pid {pid})");

        Self::spawn_stdout_reader(owner.clone(), stdout, generation);
        if let Some(stderr) = stderr {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log::info!(target: "ai", "{}", line);
                }
            });
        }

        match self
            .request_raw("get_state", json!({}), START_TIMEOUT)
            .await
        {
            Ok(data) => {
                let actual_session = data
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(actual) = actual_session.as_ref() {
                    *self.session.lock().unwrap() = Some(actual.clone());
                }
                self.ready.store(true, Ordering::SeqCst);
                self.health_failures.store(0, Ordering::SeqCst);
                self.set_status("idle", Some("AI runtime ready.".into()));
                if let Some(model) = data.get("model") {
                    log::info!(
                        "AI model: {}",
                        model.get("id").and_then(Value::as_str).unwrap_or("unknown")
                    );
                }
                let this = owner.clone();
                let expected_generation = generation;
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    if expected_generation == this.generation.load(Ordering::SeqCst)
                        && this.ready.load(Ordering::SeqCst)
                    {
                        this.restart_attempts.store(0, Ordering::SeqCst);
                    }
                });
                Ok(())
            }
            Err(error) => {
                log::error!("AI runtime handshake failed: {}", error.message);
                if let Some(mut child) = self.child.lock().await.take() {
                    let _ = child.start_kill();
                }
                *self.stdin.lock().await = None;
                self.ready.store(false, Ordering::SeqCst);
                self.set_error(error.message.clone());
                Err(error)
            }
        }
    }

    async fn stop_process(&self) {
        self.ready.store(false, Ordering::SeqCst);
        self.streaming.store(false, Ordering::SeqCst);
        // Ask Pi to stop its run before closing stdin; no response is awaited
        // because the generation is about to be invalidated.
        if self.child.lock().await.is_some() {
            let _ = self.write_command(&json!({ "type": "abort" })).await;
        }
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.fail_pending("AI runtime stopped", ERR_UNAVAILABLE);
        if self.child.lock().await.is_some() {
            *self.stdin.lock().await = None;
            let deadline = tokio::time::Instant::now() + SHUTDOWN_WAIT;
            while tokio::time::Instant::now() < deadline {
                let exited = {
                    let mut guard = self.child.lock().await;
                    match guard.as_mut() {
                        Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                        None => true,
                    }
                };
                if exited {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(75)).await;
            }
            if let Some(mut child) = self.child.lock().await.take() {
                let _ = child.start_kill();
            }
        }
        *self.stdin.lock().await = None;
        {
            let mut run = self.state.lock().unwrap();
            run.state = "stopped".into();
            run.pid = None;
            run.message = Some("AI runtime stopped.".into());
        }
        self.emit_status();
    }

    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        log::info!("Stopping AI runtime");
        self.stop_process().await;
        self.auth.stop().await;
    }

    fn spawn_stdout_reader(this: Arc<Self>, stdout: tokio::process::ChildStdout, generation: u64) {
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            let mut buffer = Vec::with_capacity(8 * 1024);
            loop {
                match read_bounded_line(&mut reader, &mut buffer, MAX_MESSAGE_BYTES).await {
                    Ok(ReadLine::Line) => {
                        let line = String::from_utf8_lossy(&buffer);
                        let line = line.trim_end_matches('\r').trim();
                        if !line.is_empty() {
                            this.handle_line(line, generation).await;
                        }
                    }
                    Ok(ReadLine::Oversized) => {
                        log::error!("Dropping oversized AI runtime frame");
                    }
                    Ok(ReadLine::Eof) => break,
                    Err(error) => {
                        log::warn!("AI runtime read failed: {error}");
                        break;
                    }
                }
            }
            this.finish_process(generation).await;
        });
    }

    async fn finish_process(self: &Arc<Self>, generation: u64) {
        let code = {
            let mut guard = self.child.lock().await;
            match guard.as_mut() {
                Some(child) => child.wait().await.ok().and_then(|status| status.code()),
                None => None,
            }
        };
        self.handle_exit(generation, code).await;
    }

    async fn handle_line(&self, line: &str, generation: u64) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        let mut value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                log::warn!("Malformed AI runtime frame: {error}");
                return;
            }
        };
        match value.get("type").and_then(Value::as_str) {
            Some("response") => {
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    if let Some(pending) = self.pending.lock().unwrap().remove(id) {
                        let result = if value.get("success").and_then(Value::as_bool) == Some(false)
                        {
                            Err(RpcErrorPayload::new(
                                ERR_INTERNAL,
                                value
                                    .get("error")
                                    .and_then(Value::as_str)
                                    .unwrap_or("AI runtime request failed")
                                    .to_string(),
                            ))
                        } else {
                            Ok(value.get("data").cloned().unwrap_or(Value::Null))
                        };
                        let _ = pending.sender.send(result);
                    } else {
                        log::debug!("AI response for unknown id {id}");
                    }
                }
            }
            Some("extension_ui_request") => {
                // The analysis extension never asks for input, but a future
                // extension change must not hang the run.
                let id = value.get("id").cloned().unwrap_or(Value::Null);
                let _ = self
                    .write_command(&json!({
                        "type": "extension_ui_response",
                        "id": id,
                        "cancelled": true
                    }))
                    .await;
            }
            Some("agent_start") => {
                self.streaming.store(true, Ordering::SeqCst);
                self.set_status("streaming", Some("Analysing…".into()));
                self.forward(&mut value);
            }
            Some("agent_settled") => {
                self.streaming.store(false, Ordering::SeqCst);
                self.set_status("idle", Some("Analysis complete.".into()));
                self.forward(&mut value);
            }
            _ => self.forward(&mut value),
        }
    }

    fn forward(&self, value: &mut Value) {
        if !forwardable(value) {
            return;
        }
        if value.get("type").and_then(Value::as_str) == Some("message_end")
            || value.get("type").and_then(Value::as_str) == Some("message_start")
        {
            if let Some(message) = value.get_mut("message") {
                context::strip_image_payloads(message);
            }
        }
        if let Some(serialized) = serde_json::to_vec(value).ok() {
            if serialized.len() > MAX_MESSAGE_BYTES / 2 {
                log::warn!("Dropping oversized AI event ({} bytes)", serialized.len());
                return;
            }
        }
        if let Err(error) = self.app.emit(AI_EVENT, &*value) {
            log::warn!("Cannot emit AI event: {error}");
        }
    }

    async fn handle_exit(self: &Arc<Self>, generation: u64, code: Option<i32>) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        let was_streaming = self.streaming.swap(false, Ordering::SeqCst);
        self.ready.store(false, Ordering::SeqCst);
        *self.child.lock().await = None;
        *self.stdin.lock().await = None;
        self.fail_pending("AI runtime exited", ERR_UNAVAILABLE);
        if self.shutting_down.load(Ordering::SeqCst) {
            self.set_status("stopped", Some("AI runtime stopped.".into()));
            return;
        }
        let detail = code
            .map(|code| format!("exit code {code}"))
            .unwrap_or_else(|| "signal".to_string());
        log::warn!("AI runtime exited ({detail})");
        self.emit_event(json!({
            "type": "process_exit",
            "code": code,
            "wasStreaming": was_streaming,
        }));
        let attempts = self.restart_attempts.fetch_add(1, Ordering::SeqCst) + 1;
        if attempts > MAX_RESTARTS {
            self.set_error(format!(
                "The AI runtime exited {attempts} times without stabilising ({detail}). Trading is unaffected. Check AI diagnostics."
            ));
            return;
        }
        let delay = restart_delay(attempts);
        {
            let mut run = self.state.lock().unwrap();
            run.state = "starting".into();
            run.attempt = attempts;
            run.pid = None;
            run.message = Some(format!(
                "AI runtime exited ({detail}); restarting in {:.0}s.",
                delay.as_secs_f32()
            ));
        }
        self.emit_status();
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            if this.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            let session = this.session.lock().unwrap().clone();
            if let Err(error) = this.spawn_locked(session).await {
                this.set_error(format!("AI runtime restart failed: {}", error.message));
            }
        });
    }

    fn monitor(this: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(HEALTH_INTERVAL).await;
                if this.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                if !this.ready.load(Ordering::SeqCst) || this.streaming.load(Ordering::SeqCst) {
                    this.health_failures.store(0, Ordering::SeqCst);
                    continue;
                }
                match this
                    .request_raw("get_state", json!({}), HEALTH_TIMEOUT)
                    .await
                {
                    Ok(_) => this.health_failures.store(0, Ordering::SeqCst),
                    Err(error) => {
                        let failures = this.health_failures.fetch_add(1, Ordering::SeqCst) + 1;
                        log::warn!(
                            "AI health check failed ({failures}/{HEALTH_FAILURE_LIMIT}): {}",
                            error.message
                        );
                        if failures >= HEALTH_FAILURE_LIMIT {
                            this.health_failures.store(0, Ordering::SeqCst);
                            let session = this.session.lock().unwrap().clone();
                            if let Err(error) = this.spawn_locked(session).await {
                                this.set_error(format!(
                                    "AI runtime restart failed: {}",
                                    error.message
                                ));
                            }
                        }
                    }
                }
            }
        });
    }

    // ── RPC plumbing ──────────────────────────────────────────────────────

    async fn request(
        &self,
        command: &str,
        extra: Value,
        timeout: Duration,
    ) -> Result<Value, RpcErrorPayload> {
        if !self.ready.load(Ordering::SeqCst) {
            return Err(RpcErrorPayload::new(
                ERR_AI_RUNTIME,
                "The AI runtime is not running.",
            ));
        }
        self.request_raw(command, extra, timeout).await
    }

    async fn request_raw(
        &self,
        command: &str,
        extra: Value,
        timeout: Duration,
    ) -> Result<Value, RpcErrorPayload> {
        let id = format!("ai-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let mut payload = json!({ "id": id, "type": command });
        if let (Some(object), Value::Object(extra)) = (payload.as_object_mut(), &extra) {
            for (key, value) in extra {
                object.insert(key.clone(), value.clone());
            }
        }
        let mut frame = serde_json::to_vec(&payload)
            .map_err(|error| RpcErrorPayload::new(ERR_INTERNAL, error.to_string()))?;
        frame.push(b'\n');
        if frame.len() > MAX_MESSAGE_BYTES {
            return Err(invalid("AI request exceeds the size limit"));
        }
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            id.clone(),
            Pending {
                command: command.to_string(),
                sender,
            },
        );
        if let Err(error) = self.write_frame(&frame).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(RpcErrorPayload::new(
                ERR_AI_RUNTIME,
                format!("Cannot write to the AI runtime: {error}"),
            ));
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcErrorPayload::new(
                ERR_UNAVAILABLE,
                "The AI runtime closed before responding.",
            )),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(RpcErrorPayload::timeout(
                    command,
                    timeout.as_millis() as u64,
                ))
            }
        }
    }

    async fn write_command(&self, value: &Value) -> Result<(), String> {
        let mut frame = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        frame.push(b'\n');
        self.write_frame(&frame).await
    }

    async fn write_frame(&self, frame: &[u8]) -> Result<(), String> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "AI runtime is not running".to_string())?;
        let write = async {
            stdin.write_all(frame).await?;
            stdin.flush().await
        };
        tokio::time::timeout(WRITE_TIMEOUT, write)
            .await
            .map_err(|_| "AI runtime did not accept the command in time".to_string())?
            .map_err(|error| error.to_string())
    }

    fn fail_pending(&self, reason: &str, code: i64) {
        let drained: Vec<Pending> = {
            let mut pending = self.pending.lock().unwrap();
            pending.drain().map(|(_, entry)| entry).collect()
        };
        for entry in drained {
            let _ = entry
                .sender
                .send(Err(RpcErrorPayload::new(code, reason.to_string())
                    .with_data(json!({
                        "command": entry.command,
                        "retryable": true,
                    }))));
        }
    }

    fn set_status(&self, state: &str, message: Option<String>) {
        {
            let mut run = self.state.lock().unwrap();
            run.state = state.to_string();
            run.message = message;
            if state != "starting" && state != "streaming" {
                run.attempt = 0;
            }
        }
        self.emit_status();
    }

    fn set_error(&self, message: String) {
        {
            let mut run = self.state.lock().unwrap();
            run.state = "error".into();
            run.message = Some(message.clone());
            run.last_error = Some(message.clone());
        }
        log::error!("AI: {message}");
        self.emit_status();
    }

    pub(crate) fn emit_status(&self) {
        let status = self.status();
        if let Err(error) = self.app.emit(AI_STATUS_EVENT, &status) {
            log::warn!("Cannot emit AI status: {error}");
        }
    }

    fn emit_event(&self, value: Value) {
        if let Err(error) = self.app.emit(AI_EVENT, &value) {
            log::warn!("Cannot emit AI event: {error}");
        }
    }
}

fn ai_key_name(provider: &str) -> String {
    format!("AI_PROVIDER_{}_API_KEY", provider.to_ascii_uppercase())
}

/// Events the UI needs. System prompt dumps and giant run summaries stay out.
fn forwardable(value: &Value) -> bool {
    match value.get("type").and_then(Value::as_str) {
        Some("response") => false,
        Some("message_start") | Some("message_end") => value
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            .is_some_and(|role| role != "system" && role != "toolResult"),
        Some("extension_ui_request") => false,
        Some("session") => false,
        _ => true,
    }
}

fn restart_delay(attempt: u32) -> Duration {
    Duration::from_secs(match attempt {
        1 => 1,
        2 => 2,
        3 => 5,
        4 => 10,
        _ => 30,
    })
}

fn count_jsonl(dir: &std::path::Path) -> usize {
    fn walk(dir: &std::path::Path) -> usize {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path)
                } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
                    1
                } else {
                    0
                }
            })
            .sum()
    }
    walk(dir)
}

fn invalid(message: impl Into<String>) -> RpcErrorPayload {
    RpcErrorPayload::new(crate::protocol::ERR_INVALID_REQUEST, message)
}

fn internal(message: impl Into<String>) -> RpcErrorPayload {
    RpcErrorPayload::new(ERR_INTERNAL, message)
}

fn not_configured() -> RpcErrorPayload {
    RpcErrorPayload::new(
        ERR_AI_NOT_CONFIGURED,
        "AI Analysis is not connected. Open AI settings and connect a provider first.",
    )
}

fn busy() -> RpcErrorPayload {
    RpcErrorPayload::new(
        ERR_AI_BUSY,
        "An analysis is already running. Stop it before starting another.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_backoff_is_bounded() {
        assert_eq!(restart_delay(1), Duration::from_secs(1));
        assert_eq!(restart_delay(4), Duration::from_secs(10));
        assert_eq!(restart_delay(99), Duration::from_secs(30));
    }

    #[test]
    fn system_and_tool_messages_are_not_forwarded() {
        let system =
            json!({ "type": "message_start", "message": { "role": "system", "sections": {} } });
        assert!(!forwardable(&system));
        let tool =
            json!({ "type": "message_end", "message": { "role": "toolResult", "content": [] } });
        assert!(!forwardable(&tool));
        let assistant =
            json!({ "type": "message_end", "message": { "role": "assistant", "content": [] } });
        assert!(forwardable(&assistant));
        let delta = json!({ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "x" } });
        assert!(forwardable(&delta));
        assert!(!forwardable(&json!({ "type": "response", "id": "1" })));
    }

    #[test]
    fn key_names_are_namespaced() {
        assert_eq!(ai_key_name("openai"), "AI_PROVIDER_OPENAI_API_KEY");
        assert_eq!(ai_key_name("google"), "AI_PROVIDER_GOOGLE_API_KEY");
    }
}

/// Human-readable provider name without depending on a hard-coded table.
fn provider_name(provider: &str) -> String {
    let label = spawn::provider_label(provider);
    if label == "Unknown provider" {
        provider.to_string()
    } else {
        label.to_string()
    }
}

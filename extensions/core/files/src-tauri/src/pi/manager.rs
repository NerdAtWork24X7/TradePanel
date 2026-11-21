//! Supervised Pi runtime.
//!
//! One lazily started child process per application. Every frame is validated
//! and size-capped; only the five read-only analysis tools are declared to the
//! model. Trading never waits on this process: a crash only ends the analysis
//! in progress, and the next Analyze chart starts a fresh child.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use opentrader_core::sync::LockExt;

use super::context;
use super::lines::{read_bounded_line, ReadLine, MAX_LINE_BYTES};
use super::paths::PiPaths;
use super::runtime;
use super::settings;
use super::spawn::{self, Launch};

const START_TIMEOUT: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_MESSAGE_CHARS: usize = 20_000;
const MAX_FORWARD_BYTES: usize = 600_000;
const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// The window's view of the runtime.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PiStatus {
    /// "streaming", "idle" or "stopped".
    pub state: String,
    pub streaming: bool,
    pub ready: bool,
    /// A base URL, a model, and a key (or a keyless loopback server).
    pub configured: bool,
    pub has_key: bool,
    pub base_url: String,
    pub model: String,
    /// The prompt Pi receives: the user's override, or the runtime's bundled one.
    pub system_prompt: String,
    /// The bundled prompt, so the editor can go back to it without a stale copy.
    pub default_prompt: String,
    pub has_custom_prompt: bool,
    pub target: Option<String>,
    pub runtime_root: Option<String>,
    pub node_version: Option<String>,
    pub pi_version: Option<String>,
    pub context_file: String,
    pub error: Option<String>,
}

struct Pending {
    sender: oneshot::Sender<Result<Value, String>>,
}

pub struct PiManager {
    app: AppHandle,
    child: AsyncMutex<Option<Child>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Pending>>,
    /// The event sink of the analysis in flight.
    active: Mutex<Option<Channel<String>>>,
    /// Serializes spawns (two quick Analyze presses must not start two children).
    starting: AsyncMutex<()>,
    ready: AtomicBool,
    streaming: AtomicBool,
    generation: AtomicU64,
    next_id: AtomicU64,
    stderr: Mutex<String>,
    last_error: Mutex<Option<String>>,
}

impl PiManager {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            child: AsyncMutex::new(None),
            stdin: AsyncMutex::new(None),
            pending: Mutex::new(HashMap::new()),
            active: Mutex::new(None),
            starting: AsyncMutex::new(()),
            ready: AtomicBool::new(false),
            streaming: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            next_id: AtomicU64::new(1),
            stderr: Mutex::new(String::new()),
            last_error: Mutex::new(None),
        })
    }

    pub fn status(&self) -> PiStatus {
        let mut saved = settings::load(&self.app);
        // The old direct analyst stored the full `/chat/completions` endpoint.
        // Pi wants the base; migrate the file once so every reader agrees.
        let base = settings::normalize_base(&saved.base_url);
        if base != saved.base_url {
            saved.base_url = base.clone();
            let _ = settings::save(&self.app, &saved);
        }
        let has_key = settings::key(&self.app).is_some();
        let custom_prompt = saved.system_prompt.clone();
        let runtime = runtime::resolve(&self.app);
        let default_prompt = runtime
            .as_ref()
            .ok()
            .and_then(|rt| std::fs::read_to_string(&rt.system_prompt).ok())
            .unwrap_or_default();
        let (target, runtime_root, node_version, pi_version, runtime_error) = match &runtime {
            Ok(rt) => (
                Some(rt.target.clone()),
                Some(rt.root.to_string_lossy().into_owned()),
                rt.node_version.clone(),
                rt.pi_version.clone(),
                None,
            ),
            Err(error) => (None, None, None, None, Some(error.clone())),
        };
        let ready = self.ready.load(Ordering::SeqCst);
        let streaming = self.streaming.load(Ordering::SeqCst);
        let error = self.last_error.locked().clone().or(runtime_error);
        PiStatus {
            state: if streaming {
                "streaming"
            } else if ready {
                "idle"
            } else {
                "stopped"
            }
            .into(),
            streaming,
            ready,
            configured: !base.is_empty() && !saved.model.is_empty() && (has_key || settings::is_loopback(&base)),
            has_key,
            base_url: base,
            model: saved.model,
            system_prompt: custom_prompt.clone().unwrap_or_else(|| default_prompt.clone()),
            default_prompt,
            has_custom_prompt: custom_prompt.is_some(),
            target,
            runtime_root,
            node_version,
            pi_version,
            context_file: PiPaths::for_app(&self.app)
                .map(|p| p.context_file.to_string_lossy().into_owned())
                .unwrap_or_default(),
            error,
        }
    }

    /// Save the provider and prompt; a non-empty `api_key` replaces the stored
    /// key and `None` for `system_prompt` restores the runtime's built-in
    /// prompt. The running child is stopped so the next analysis starts with
    /// the new settings.
    pub async fn set_settings(
        &self,
        base_url: String,
        model: String,
        api_key: Option<String>,
        system_prompt: Option<String>,
    ) -> Result<PiStatus, String> {
        let base = settings::endpoint(&base_url)?;
        let model = settings::validate_model(&model)?;
        let system_prompt = system_prompt.map(|text| settings::validate_prompt(&text)).transpose()?;
        if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
            settings::set_key(&self.app, key.trim())?;
        }
        let paths = PiPaths::for_app(&self.app)?;
        paths.create()?;
        if let Some(text) = &system_prompt {
            settings::write_prompt(&paths.agent, text)?;
        }
        let has_key = settings::key(&self.app).is_some();
        settings::write_models(&paths.agent, &base, &model, has_key)?;
        settings::save(&self.app, &settings::Saved { base_url: base, model, system_prompt })?;
        self.stop_child().await;
        *self.last_error.locked() = None;
        Ok(self.status())
    }

    pub async fn clear_key(&self) -> Result<PiStatus, String> {
        settings::clear_key(&self.app)?;
        self.stop_child().await;
        Ok(self.status())
    }

    /// Start one read-only analysis. Events stream on `channel` until
    /// `agent_settled` or the process exits.
    pub async fn analyze(self: &Arc<Self>, snapshot: Value, images: Value, message: String, channel: Channel<String>) -> Result<(), String> {
        let message = message.trim().to_string();
        if message.is_empty() || message.chars().count() > MAX_MESSAGE_CHARS {
            return Err(format!("The analysis prompt must be between 1 and {MAX_MESSAGE_CHARS} characters."));
        }
        if self.streaming.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Err("An analysis is already running.".into());
        }
        let result = self.analyze_inner(snapshot, images, message, channel).await;
        if let Err(error) = &result {
            self.streaming.store(false, Ordering::SeqCst);
            self.active.locked().take();
            *self.last_error.locked() = Some(error.clone());
        }
        result
    }

    async fn analyze_inner(self: &Arc<Self>, snapshot: Value, images: Value, message: String, channel: Channel<String>) -> Result<(), String> {
        let saved = settings::load(&self.app);
        let base = settings::endpoint(&saved.base_url)?;
        settings::validate_model(&saved.model)?;
        if !settings::is_loopback(&base) && settings::key(&self.app).is_none() {
            return Err("Set the analyst's API key in its settings.".into());
        }
        let paths = PiPaths::for_app(&self.app)?;
        paths.create()?;
        context::write_snapshot(&paths.context_file, &snapshot)?;
        let images = context::parse_images(&images)?;
        self.ensure_child().await?;
        // `ensure_child` may stop a stale child (which clears the streaming
        // flag): the run under way claims it again before anything is sent.
        self.streaming.store(true, Ordering::SeqCst);

        *self.active.locked() = Some(channel);
        let mut payload = json!({ "message": message });
        if !images.is_empty() {
            payload["images"] = Value::Array(images);
        }
        let started = self.request("prompt", payload, REQUEST_TIMEOUT).await;
        let started = match started {
            Ok(value) => value,
            Err(error) => {
                self.active.locked().take();
                return Err(error);
            }
        };
        let disposition = started.get("disposition").and_then(Value::as_str).unwrap_or("started");
        if disposition == "handled" {
            return Err("The analysis prompt was consumed without starting a run.".into());
        }
        *self.last_error.locked() = None;
        Ok(())
    }

    /// Abort the run in progress (the text received so far stays).
    pub async fn abort(&self) -> Result<(), String> {
        if !self.ready.load(Ordering::SeqCst) {
            self.streaming.store(false, Ordering::SeqCst);
            return Ok(());
        }
        let _ = self.request("abort", json!({}), Duration::from_secs(20)).await;
        Ok(())
    }

    /// Drop the conversation: the next analysis starts a new process and a new
    /// Pi session.
    pub async fn new_session(&self) {
        self.stop_child().await;
    }

    pub async fn shutdown(&self) {
        self.stop_child().await;
    }

    /// The runtime is about to be swapped on disk: release its files first.
    pub(crate) async fn prepare_update(&self) {
        self.stop_child().await;
    }

    /// A successful update makes a previous launch failure stale.
    pub(crate) fn clear_runtime_error(&self) {
        *self.last_error.locked() = None;
    }

    // ── Process lifecycle ─────────────────────────────────────────────────

    /// A saved custom prompt lives in the agent directory, not in the staged
    /// runtime (which an in-app update replaces). Rewriting it on each spawn
    /// also covers a settings file changed while the app was closed.
    fn prompt_override(&self, paths: &PiPaths, saved: &settings::Saved) -> Result<Option<PathBuf>, String> {
        match saved.system_prompt.as_deref() {
            Some(text) => Ok(Some(settings::write_prompt(&paths.agent, &settings::validate_prompt(text)?)?)),
            None => Ok(None),
        }
    }

    async fn ensure_child(self: &Arc<Self>) -> Result<(), String> {
        let _spawn = self.starting.lock().await;
        if self.ready.load(Ordering::SeqCst) && self.child.lock().await.is_some() {
            return Ok(());
        }
        self.stop_child().await;

        let saved = settings::load(&self.app);
        let base = settings::endpoint(&saved.base_url)?;
        let model = settings::validate_model(&saved.model)?;
        // A settings file written by the old direct analyst stored the full
        // `/chat/completions` endpoint: save the base back once, so the next
        // window shows what Pi actually uses.
        if saved.base_url != base || saved.model != model {
            let _ = settings::save(&self.app, &settings::Saved {
                base_url: base.clone(),
                model: model.clone(),
                system_prompt: saved.system_prompt.clone(),
            });
        }
        let key = settings::key(&self.app);
        let paths = PiPaths::for_app(&self.app)?;
        paths.create()?;
        settings::write_models(&paths.agent, &base, &model, key.is_some())?;
        let system_prompt_override = self.prompt_override(&paths, &saved)?;
        let runtime = runtime::resolve(&self.app)?;
        let launch = Launch {
            runtime: &runtime,
            paths: &paths,
            provider: spawn::PROVIDER_ID,
            model: &model,
            provider_key: key.as_deref().unwrap_or(""),
            system_prompt_override: system_prompt_override.as_deref(),
        };

        let mut command = tokio::process::Command::new(&runtime.node);
        command.arg(&runtime.pi_cli);
        command.args(spawn::args(&launch));
        command.env_clear();
        for (name, value) in spawn::env_pairs(&launch) {
            command.env(name, value);
        }
        command.current_dir(spawn::working_dir(&launch));
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start the analysis runtime ({}): {e}", runtime.node.display()))?;
        let stdin = child.stdin.take().ok_or_else(|| "The analysis runtime has no stdin.".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "The analysis runtime has no stdout.".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "The analysis runtime has no stderr.".to_string())?;
        *self.stdin.lock().await = Some(stdin);
        *self.child.lock().await = Some(child);
        *self.stderr.locked() = String::new();
        self.ready.store(true, Ordering::SeqCst);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.spawn_readers(generation, stdout, stderr);

        // The CLI answers `get_state` only once the runtime (provider catalogue,
        // extensions, model) is ready. A failure here is a startup failure.
        match self.request("get_state", json!({}), START_TIMEOUT).await {
            Ok(_) => {
                *self.last_error.locked() = None;
                Ok(())
            }
            Err(error) => {
                self.stop_child().await;
                Err(format!("The analysis runtime did not start: {error}"))
            }
        }
    }

    async fn stop_child(&self) {
        // Cut the reader loose first: its exit report belongs to the old child.
        self.generation.fetch_add(1, Ordering::SeqCst);
        let was_streaming = self.streaming.swap(false, Ordering::SeqCst);
        if was_streaming {
            let _ = self.write_command(&json!({ "type": "abort" })).await;
        }
        self.ready.store(false, Ordering::SeqCst);
        if let Some(channel) = self.active.locked().take() {
            let _ = channel.send(
                json!({ "type": "process_exit", "code": null, "error": "The analysis runtime was stopped." }).to_string(),
            );
        }
        if let Some(mut stdin) = self.stdin.lock().await.take() {
            let _ = stdin.shutdown().await;
        }
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
        }
        self.fail_pending("The analysis runtime was stopped.");
    }

    fn spawn_readers(self: &Arc<Self>, generation: u64, stdout: ChildStdout, stderr: ChildStderr) {
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buffer = Vec::new();
            loop {
                match read_bounded_line(&mut reader, &mut buffer, MAX_LINE_BYTES).await {
                    Ok(ReadLine::Line) => {
                        let line = String::from_utf8_lossy(&buffer).into_owned();
                        this.handle_line(&line, generation).await;
                    }
                    Ok(ReadLine::Oversized) => eprintln!("[pi] dropped an oversized runtime frame"),
                    Ok(ReadLine::Eof) => break,
                    Err(error) => {
                        eprintln!("[pi] stdout: {error}");
                        break;
                    }
                }
            }
            this.handle_exit(generation).await;
        });

        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buffer = Vec::new();
            loop {
                match read_bounded_line(&mut reader, &mut buffer, 64 * 1024).await {
                    Ok(ReadLine::Line) => {
                        let line = String::from_utf8_lossy(&buffer);
                        let mut tail = this.stderr.locked();
                        tail.push_str(&line);
                        tail.push('\n');
                        if tail.len() > STDERR_TAIL_BYTES {
                            let cut = tail.len() - STDERR_TAIL_BYTES;
                            *tail = tail[cut..].to_string();
                        }
                    }
                    Ok(ReadLine::Oversized) => {}
                    Ok(ReadLine::Eof) | Err(_) => break,
                }
            }
        });
    }

    async fn handle_exit(self: &Arc<Self>, generation: u64) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        self.ready.store(false, Ordering::SeqCst);
        self.streaming.store(false, Ordering::SeqCst);
        *self.stdin.lock().await = None;
        let mut child = self.child.lock().await.take();
        let code = match child.as_mut() {
            Some(child) => match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(status)) => status.code(),
                _ => None,
            },
            None => None,
        };
        self.fail_pending("The analysis runtime exited.");
        let tail = self.stderr_tail();
        let error = if tail.is_empty() {
            format!(
                "The analysis runtime exited unexpectedly ({}).",
                code.map(|code| format!("code {code}")).unwrap_or_else(|| "signal".into())
            )
        } else {
            tail
        };
        *self.last_error.locked() = Some(error.clone());
        if let Some(channel) = self.active.locked().take() {
            let _ = channel.send(json!({ "type": "process_exit", "code": code, "error": error }).to_string());
        }
    }

    fn stderr_tail(&self) -> String {
        let tail = self.stderr.locked();
        let lines: Vec<&str> = tail.lines().filter(|line| !line.trim().is_empty()).collect();
        lines[lines.len().saturating_sub(6)..].join(" ")
    }

    // ── RPC plumbing ──────────────────────────────────────────────────────

    async fn request(&self, command: &str, extra: Value, timeout: Duration) -> Result<Value, String> {
        if !self.ready.load(Ordering::SeqCst) {
            return Err("The analysis runtime is not running.".into());
        }
        let id = format!("pi-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let mut payload = json!({ "id": id, "type": command });
        if let (Some(object), Value::Object(extra)) = (payload.as_object_mut(), &extra) {
            object.extend(extra.clone());
        }
        let (sender, receiver) = oneshot::channel();
        self.pending.locked().insert(id.clone(), Pending { sender });
        if let Err(error) = self.write_command(&payload).await {
            self.pending.locked().remove(&id);
            return Err(format!("Cannot write to the analysis runtime: {error}"));
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The analysis runtime closed before answering.".into()),
            Err(_) => {
                self.pending.locked().remove(&id);
                Err(format!("The analysis runtime did not answer '{command}' in time."))
            }
        }
    }

    async fn write_command(&self, value: &Value) -> Result<(), String> {
        let mut frame = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        frame.push(b'\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or_else(|| "The analysis runtime is not running.".to_string())?;
        let write = async {
            stdin.write_all(&frame).await?;
            stdin.flush().await
        };
        tokio::time::timeout(WRITE_TIMEOUT, write)
            .await
            .map_err(|_| "The analysis runtime did not accept the command in time.".to_string())?
            .map_err(|e| e.to_string())
    }

    async fn handle_line(self: &Arc<Self>, line: &str, generation: u64) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        let mut value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[pi] malformed frame: {error}");
                return;
            }
        };
        match value.get("type").and_then(Value::as_str) {
            Some("response") => {
                let Some(id) = value.get("id").and_then(Value::as_str) else {
                    return;
                };
                let Some(pending) = self.pending.locked().remove(id) else {
                    return;
                };
                let result = if value.get("success").and_then(Value::as_bool) == Some(false) {
                    Err(value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("The analysis runtime request failed.")
                        .to_string())
                } else {
                    Ok(value.get("data").cloned().unwrap_or(Value::Null))
                };
                let _ = pending.sender.send(result);
            }
            Some("extension_ui_request") => {
                // The analysis extension never asks for input, but a future
                // extension change must not hang the run.
                let id = value.get("id").cloned().unwrap_or(Value::Null);
                let _ = self
                    .write_command(&json!({ "type": "extension_ui_response", "id": id, "cancelled": true }))
                    .await;
            }
            Some("agent_start") => {
                self.streaming.store(true, Ordering::SeqCst);
                self.send_event(&value);
            }
            Some("agent_settled") => {
                self.streaming.store(false, Ordering::SeqCst);
                self.send_event(&value);
                self.active.locked().take();
            }
            Some("message_end") => {
                let role = value
                    .get("message")
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if role.as_deref() == Some("system") {
                    return;
                }
                if let Some(message) = value.get_mut("message") {
                    context::strip_images(message);
                    if message.get("stopReason").and_then(Value::as_str) == Some("error") {
                        if let Some(error) = message.get("errorMessage").and_then(Value::as_str) {
                            *self.last_error.locked() = Some(error.to_string());
                        }
                    }
                }
                self.send_event(&value);
            }
            Some("message_update") | Some("tool_execution_start") | Some("tool_execution_end") | Some("agent_end") | Some("turn_end") => {
                self.send_event(&value);
            }
            _ => {}
        }
    }

    fn send_event(&self, value: &Value) {
        let Some(channel) = self.active.locked().clone() else {
            return;
        };
        let Ok(text) = serde_json::to_string(value) else {
            return;
        };
        if text.len() > MAX_FORWARD_BYTES {
            eprintln!("[pi] dropped an oversized event ({} bytes)", text.len());
            return;
        }
        let _ = channel.send(text);
    }

    fn fail_pending(&self, reason: &str) {
        let drained: Vec<Pending> = {
            let mut pending = self.pending.locked();
            pending.drain().map(|(_, entry)| entry).collect()
        };
        for entry in drained {
            let _ = entry.sender.send(Err(reason.to_string()));
        }
    }
}

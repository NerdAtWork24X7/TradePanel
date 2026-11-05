//! Supervised Python sidecar process.
//!
//! Responsibilities:
//! * spawn exactly one one-folder sidecar executable at a time,
//! * correlate JSON-RPC responses with pending requests,
//! * forward backend notifications to the WebView as `backend:event`,
//! * health-check (`system.ping`) and restart with bounded exponential backoff,
//! * fail pending trading requests with `EXECUTION_UNKNOWN` if the process dies,
//! * graceful shutdown (the backend gets a grace period for in-flight orders).
//!
//! The one-folder PyInstaller build is used deliberately: a one-file build runs
//! a bootloader parent and a Python child, which makes killing the process the
//! shell spawned unreliable. One folder = one process = deterministic
//! supervision. `Command::kill_on_drop` is a final safety net.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::events::{emit_backend_notification, emit_status};
use crate::protocol::{
    is_order_method, request_frame, BackendStatus, Incoming, RpcErrorPayload, ERR_PROTOCOL_MISMATCH,
    ERR_UNAVAILABLE, MAX_MESSAGE_BYTES, PROTOCOL_VERSION,
};
use crate::security::SecretStore;

const HEALTH_INTERVAL: Duration = Duration::from_secs(10);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);
const HEALTH_FAILURE_LIMIT: u32 = 3;
const MAX_RESTART_ATTEMPTS: u32 = 6;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_WAIT: Duration = Duration::from_secs(12);

struct Pending {
    method: String,
    sender: oneshot::Sender<Result<Value, RpcErrorPayload>>,
}

pub struct SidecarManager {
    app: AppHandle,
    binary: PathBuf,
    data_dir: PathBuf,
    keys_dir: PathBuf,
    app_version: String,
    credentials: Arc<SecretStore>,
    child: AsyncMutex<Option<Child>>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Pending>>,
    status: Mutex<BackendStatus>,
    env_secrets: Mutex<HashMap<String, String>>,
    next_id: AtomicU64,
    generation: AtomicU64,
    exited_generation: AtomicU64,
    spawn_lock: AsyncMutex<()>,
    ready: AtomicBool,
    incompatible: AtomicBool,
    shutting_down: AtomicBool,
    health_failures: AtomicU32,
    restart_attempts: AtomicU32,
}

impl SidecarManager {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        app: AppHandle,
        binary: PathBuf,
        data_dir: PathBuf,
        keys_dir: PathBuf,
        app_version: String,
        credentials: Arc<SecretStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            app,
            binary,
            data_dir,
            keys_dir,
            app_version,
            credentials,
            child: AsyncMutex::new(None),
            stdin: AsyncMutex::new(None),
            pending: Mutex::new(HashMap::new()),
            status: Mutex::new(BackendStatus::new("starting")),
            env_secrets: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            generation: AtomicU64::new(0),
            exited_generation: AtomicU64::new(0),
            spawn_lock: AsyncMutex::new(()),
            ready: AtomicBool::new(false),
            incompatible: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            health_failures: AtomicU32::new(0),
            restart_attempts: AtomicU32::new(0),
        })
    }

    pub fn status(&self) -> BackendStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn start(self: &Arc<Self>) {
        log::info!("Starting Python sidecar supervisor ({})", self.binary.display());
        Self::monitor(self.clone());
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = this.spawn_process(true).await {
                log::error!("Initial backend start failed: {error}");
            }
        });
    }

    /// Restart requested by the UI ("Retry backend").
    pub async fn restart(self: &Arc<Self>) -> Result<(), RpcErrorPayload> {
        self.incompatible.store(false, Ordering::SeqCst);
        self.shutting_down.store(false, Ordering::SeqCst);
        self.restart_attempts.store(0, Ordering::SeqCst);
        self.spawn_process(true)
            .await
            .map_err(RpcErrorPayload::unavailable)
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcErrorPayload> {
        if !self.ready.load(Ordering::SeqCst) {
            return Err(RpcErrorPayload::unavailable(
                "Backend is not running. Trading controls stay disabled until it reconnects.",
            ));
        }
        self.send_raw(method, params, timeout).await
    }

    pub async fn set_credentials(
        &self,
        values: HashMap<String, String>,
        clear: Vec<String>,
    ) -> Result<(), RpcErrorPayload> {
        {
            let mut env = self.env_secrets.lock().unwrap();
            for key in &clear {
                env.remove(key);
            }
            for (key, value) in &values {
                env.insert(key.clone(), value.clone());
            }
        }
        if !self.ready.load(Ordering::SeqCst) {
            return Ok(());
        }
        let payload = json!({ "values": values, "clear": clear });
        self.send_raw("system.set_credentials", payload, Duration::from_secs(10))
            .await
            .map(|_| ())
    }

    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        log::info!("Stopping Python sidecar");
        if self.child.lock().await.is_some() {
            let _ = self
                .send_raw("system.shutdown", json!({}), Duration::from_secs(2))
                .await;
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
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if let Some(mut child) = self.child.lock().await.take() {
                log::warn!("Backend did not exit in time; killing it");
                let _ = child.start_kill();
            }
            *self.stdin.lock().await = None;
        }
        self.ready.store(false, Ordering::SeqCst);
        self.fail_pending("Backend stopped", ERR_UNAVAILABLE);
        self.set_status(BackendStatus::new("stopped"));
    }

    // ── Spawning ────────────────────────────────────────────────────────────

    async fn spawn_process(self: &Arc<Self>, manual: bool) -> Result<(), String> {
        let _guard = self.spawn_lock.lock().await;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("Application is shutting down".to_string());
        }

        // Invalidate the previous generation before killing it so its exit
        // handler cannot trigger a second restart.
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.ready.store(false, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.start_kill();
        }
        *self.stdin.lock().await = None;
        self.fail_pending("Backend is restarting", ERR_UNAVAILABLE);

        let stored = self.credentials.clone();
        let from_store = tauri::async_runtime::spawn_blocking(move || stored.load_into_env())
            .await
            .unwrap_or_default();

        let mut envs: HashMap<String, String> = from_store;
        envs.extend(self.env_secrets.lock().unwrap().clone());
        envs.insert(
            "TRADEPANEL_DATA_DIR".to_string(),
            self.data_dir.to_string_lossy().to_string(),
        );
        envs.insert(
            "TRADEPANEL_KEYS_DIR".to_string(),
            self.keys_dir.to_string_lossy().to_string(),
        );
        // Secrets come from the OS keyring; never re-read a plaintext .env.
        envs.insert("TRADEPANEL_IGNORE_ENV_FILE".to_string(), "1".to_string());
        // numba's optional TBB layer is not bundled (no libtbb dependency).
        envs.insert("NUMBA_THREADING_LAYER".to_string(), "workqueue".to_string());

        let mut command = Command::new(&self.binary);
        command
            .arg("--stdio")
            .envs(envs)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: the sidecar needs stdio pipes but no console.
            command.creation_flags(0x0800_0000);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start {}: {error}", self.binary.display()))?;
        let pid = child.id().unwrap_or(0);
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "The backend did not provide a stdout pipe".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "The backend did not provide a stderr pipe".to_string())?;

        *self.child.lock().await = Some(child);
        *self.stdin.lock().await = stdin;

        self.set_status(
            BackendStatus::new("starting")
                .with_pid(pid)
                .with_message("Starting Python backend…"),
        );
        if manual {
            log::info!("Spawned backend sidecar (pid {pid})");
        } else {
            log::warn!("Restarted backend sidecar (pid {pid})");
        }

        Self::spawn_stdout_reader(self.clone(), stdout, generation);
        Self::spawn_stderr_reader(self.clone(), stderr);

        // Handshake: protocol compatibility is a hard gate.
        let hello = self
            .send_raw(
                "system.hello",
                json!({
                    "protocol_version": PROTOCOL_VERSION,
                    "client": format!("TradePanel/{}", self.app_version),
                }),
                HANDSHAKE_TIMEOUT,
            )
            .await;

        match hello {
            Ok(result) => {
                let protocol = result
                    .get("protocol_version")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as u32;
                let backend_version = result
                    .get("backend_version")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                if protocol != PROTOCOL_VERSION {
                    self.incompatible.store(true, Ordering::SeqCst);
                    self.ready.store(false, Ordering::SeqCst);
                    self.set_status(
                        BackendStatus::new("incompatible")
                            .with_pid(pid)
                            .with_message(format!(
                                "Backend protocol {protocol} is incompatible with the shell protocol {PROTOCOL_VERSION}. Reinstall the complete application."
                            ))
                            .with_versions(protocol, backend_version),
                    );
                    if let Some(mut child) = self.child.lock().await.take() {
                        let _ = child.start_kill();
                    }
                    return Err("Backend protocol mismatch".to_string());
                }

                self.ready.store(true, Ordering::SeqCst);
                self.health_failures.store(0, Ordering::SeqCst);
                self.set_status(
                    BackendStatus::new("running")
                        .with_pid(pid)
                        .with_versions(protocol, backend_version.clone())
                        .with_message("Backend connected"),
                );
                log::info!("Backend handshake OK (protocol {protocol}, version {backend_version})");

                // A process that survives a minute is considered healthy; only
                // then clear the crash-loop counter.
                let this = self.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    if generation == this.generation.load(Ordering::SeqCst)
                        && this.ready.load(Ordering::SeqCst)
                    {
                        this.restart_attempts.store(0, Ordering::SeqCst);
                    }
                });
                Ok(())
            }
            Err(error) => {
                self.ready.store(false, Ordering::SeqCst);
                log::error!("Backend handshake failed: {}", error.message);
                if error.code == ERR_PROTOCOL_MISMATCH {
                    self.incompatible.store(true, Ordering::SeqCst);
                    self.set_status(
                        BackendStatus::new("incompatible")
                            .with_pid(pid)
                            .with_message(error.message.clone()),
                    );
                } else {
                    self.set_status(
                        BackendStatus::new("failed")
                            .with_pid(pid)
                            .with_message(error.message.clone()),
                    );
                }
                if let Some(mut child) = self.child.lock().await.take() {
                    let _ = child.start_kill();
                }
                Err(error.message)
            }
        }
    }

    fn spawn_stdout_reader(
        self: Arc<Self>,
        stdout: tokio::process::ChildStdout,
        generation: u64,
    ) {
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::with_capacity(32 * 1024, stdout);
            let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);
            loop {
                match read_bounded_line(&mut reader, &mut buffer, MAX_MESSAGE_BYTES).await {
                    Ok(ReadLine::Line) => {
                        let line = String::from_utf8_lossy(&buffer);
                        let line = line.trim_end_matches('\r').trim();
                        if !line.is_empty() {
                            self.handle_line(line);
                        }
                    }
                    Ok(ReadLine::Oversized) => {
                        log::error!("Dropping oversized backend frame (> {MAX_MESSAGE_BYTES} bytes)");
                    }
                    Ok(ReadLine::Eof) => break,
                    Err(error) => {
                        log::warn!("Backend stdout read failed: {error}");
                        break;
                    }
                }
            }
            self.finish_process(generation).await;
        });
    }

    fn spawn_stderr_reader(self: Arc<Self>, stderr: tokio::process::ChildStderr) {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::info!(target: "backend", "{}", line);
            }
        });
    }

    async fn finish_process(self: &Arc<Self>, generation: u64) {
        let code = {
            let mut guard = self.child.lock().await;
            match guard.as_mut() {
                Some(child) => child
                    .wait()
                    .await
                    .ok()
                    .and_then(|status| status.code()),
                None => None,
            }
        };
        if generation == self.generation.load(Ordering::SeqCst) {
            *self.stdin.lock().await = None;
        }
        self.handle_exit(generation, code).await;
    }

    fn handle_line(&self, line: &str) {
        match crate::protocol::parse_incoming(line) {
            Incoming::Response { id, result } => {
                let entry = self.pending.lock().unwrap().remove(&id);
                match entry {
                    Some(pending) => {
                        let _ = pending.sender.send(result);
                    }
                    None => log::debug!("Response for unknown request id {id}"),
                }
            }
            Incoming::Notification { method, params } => {
                emit_backend_notification(&self.app, &method, params);
            }
            Incoming::Invalid { id, error } => {
                log::warn!(
                    "Invalid backend frame (id {:?}): {} ({})",
                    id,
                    error.message,
                    error.code
                );
            }
            Incoming::Ignored => {}
        }
    }

    // ── Requests ────────────────────────────────────────────────────────────

    async fn send_raw(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcErrorPayload> {
        let id = format!("rpc-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            id.clone(),
            Pending { method: method.to_string(), sender },
        );

        let frame = request_frame(&id, method, &params);
        if frame.len() > MAX_MESSAGE_BYTES {
            self.pending.lock().unwrap().remove(&id);
            return Err(RpcErrorPayload::new(
                crate::protocol::ERR_INVALID_REQUEST,
                format!("Request '{method}' exceeds the {} byte limit", MAX_MESSAGE_BYTES),
            ));
        }
        if let Err(error) = self.write_frame(&frame).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(RpcErrorPayload::unavailable(format!(
                "Cannot write to the backend: {error}"
            )));
        }

        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcErrorPayload::unavailable(
                "Backend connection closed before the response arrived",
            )),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                if is_order_method(method) {
                    Err(RpcErrorPayload::execution_unknown(
                        method,
                        "the backend did not answer before the deadline",
                    ))
                } else {
                    Err(RpcErrorPayload::timeout(
                        method,
                        timeout.as_millis() as u64,
                    ))
                }
            }
        }
    }

    async fn write_frame(&self, frame: &[u8]) -> Result<(), String> {
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or_else(|| "Backend is not running".to_string())?;
        stdin.write_all(frame).await.map_err(|error| error.to_string())?;
        stdin.flush().await.map_err(|error| error.to_string())
    }

    fn fail_pending(&self, reason: &str, code: i64) {
        let drained: Vec<(String, Pending)> = {
            let mut pending = self.pending.lock().unwrap();
            pending.drain().collect()
        };
        for (_, entry) in drained {
            let error = if is_order_method(&entry.method) {
                RpcErrorPayload::execution_unknown(&entry.method, reason)
            } else {
                RpcErrorPayload::new(code, reason)
            };
            let _ = entry.sender.send(Err(error));
        }
    }

    async fn handle_exit(self: &Arc<Self>, generation: u64, exit_code: Option<i32>) {
        if generation != self.generation.load(Ordering::SeqCst) {
            return;
        }
        if self.exited_generation.swap(generation, Ordering::SeqCst) == generation {
            return;
        }

        self.ready.store(false, Ordering::SeqCst);
        *self.child.lock().await = None;
        *self.stdin.lock().await = None;
        self.fail_pending("Backend process exited", ERR_UNAVAILABLE);

        if self.shutting_down.load(Ordering::SeqCst) {
            self.set_status(BackendStatus::new("stopped").with_message("Backend stopped"));
            return;
        }
        if self.incompatible.load(Ordering::SeqCst) {
            self.set_status(
                BackendStatus::new("incompatible")
                    .with_message("Backend protocol mismatch; automatic restart disabled"),
            );
            return;
        }

        let attempts = self.restart_attempts.fetch_add(1, Ordering::SeqCst) + 1;
        if attempts > MAX_RESTART_ATTEMPTS {
            self.set_status(
                BackendStatus::new("failed").with_message(format!(
                    "Backend exited {attempts} times without stabilising. Use Retry backend after checking the logs."
                )),
            );
            return;
        }

        let delay = restart_delay(attempts);
        log::warn!(
            "Backend exited (code {:?}); restart attempt {attempts} in {} ms",
            exit_code,
            delay.as_millis()
        );
        self.set_status(
            BackendStatus::new("restarting").with_message(format!(
                "Backend exited (code {}). Reconnecting in {:.0}s — trading is disabled.",
                exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "signal".to_string()),
                delay.as_secs_f32()
            )),
        );

        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            if this.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            if let Err(error) = this.spawn_process(false).await {
                log::error!("Backend restart failed: {error}");
            }
        });
    }

    fn monitor(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(HEALTH_INTERVAL).await;
                if self.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                if !self.ready.load(Ordering::SeqCst) {
                    self.health_failures.store(0, Ordering::SeqCst);
                    continue;
                }
                match self
                    .send_raw("system.ping", json!({}), HEALTH_TIMEOUT)
                    .await
                {
                    Ok(_) => {
                        self.health_failures.store(0, Ordering::SeqCst);
                    }
                    Err(error) => {
                        let failures = self.health_failures.fetch_add(1, Ordering::SeqCst) + 1;
                        log::warn!(
                            "Backend health check failed ({}/{}) — {}",
                            failures,
                            HEALTH_FAILURE_LIMIT,
                            error.message
                        );
                        if failures >= HEALTH_FAILURE_LIMIT {
                            log::error!("Backend unresponsive; restarting");
                            self.health_failures.store(0, Ordering::SeqCst);
                            if let Err(error) = self.spawn_process(true).await {
                                log::error!("Forced restart failed: {error}");
                            }
                        }
                    }
                }
            }
        });
    }

    fn set_status(&self, status: BackendStatus) {
        let status = status.now();
        *self.status.lock().unwrap() = status.clone();
        emit_status(&self.app, &status);
    }
}

enum ReadLine {
    Line,
    Oversized,
    Eof,
}

/// Read one newline-delimited frame with a hard size cap.
///
/// `BufRead::lines()` would allocate an unbounded string for a malformed
/// backend, so oversized frames are drained and reported instead.
async fn read_bounded_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    out: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<ReadLine> {
    use tokio::io::AsyncBufReadExt;
    out.clear();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if out.is_empty() && !oversized {
                return Ok(ReadLine::Eof);
            }
            return Ok(if oversized { ReadLine::Oversized } else { ReadLine::Line });
        }
        if let Some(index) = available.iter().position(|byte| *byte == b'\n') {
            if !oversized {
                if out.len() + index > limit {
                    oversized = true;
                    out.clear();
                } else {
                    out.extend_from_slice(&available[..index]);
                }
            }
            reader.consume(index + 1);
            return Ok(if oversized { ReadLine::Oversized } else { ReadLine::Line });
        }
        let available_len = available.len();
        if !oversized {
            if out.len() + available_len > limit {
                oversized = true;
                out.clear();
            } else {
                out.extend_from_slice(available);
            }
        }
        reader.consume(available_len);
    }
}

fn restart_delay(attempt: u32) -> Duration {
    let seconds = match attempt {
        1 => 1,
        2 => 2,
        3 => 5,
        4 => 10,
        _ => 30,
    };
    Duration::from_secs(seconds)
}

#[cfg(test)]
mod tests {
    use super::restart_delay;
    use std::time::Duration;

    #[test]
    fn restart_backoff_is_bounded() {
        assert_eq!(restart_delay(1), Duration::from_secs(1));
        assert_eq!(restart_delay(3), Duration::from_secs(5));
        assert_eq!(restart_delay(99), Duration::from_secs(30));
    }
}

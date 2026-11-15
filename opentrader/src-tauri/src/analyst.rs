/*
 * The chart analyst: a read-only vision request about the chart the user is looking at
 * (TradePanel's "AI that sees your charts", without the bundled Pi runtime).
 *
 * The window renders the shown charts (chartSnapshot / layoutSnapshot) into a PNG data URL
 * and sends the OpenAI-compatible messages here. The provider's URL, model and API key stay
 * in Rust: the key in the system credential store, never in the webview, and Rust adds the
 * Authorization header. Only HTTPS endpoints and loopback HTTP (a local llama.cpp / Ollama
 * style server) are accepted, so a mistaken base URL cannot leak a key to a plain remote
 * host. Nothing in this module can trade: no order command is reachable from it.
 */
use crate::credentials;
use opentrader_core::files;
use opentrader_core::net::SharedClient;
use opentrader_core::sync::LockExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

const FILE: &str = "analyst.json";
const KEYRING_ACCOUNT: &str = "analyst-api-key";
const MAX_BODY: usize = 16 * 1024 * 1024;

static CLIENT: SharedClient = SharedClient::new(|b| b.connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(300)));
static RUNNING: Mutex<Option<HashMap<u32, oneshot::Sender<()>>>> = Mutex::new(None);

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Saved {
    base_url: String,
    model: String,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalystSettings {
    /// The OpenAI-compatible base URL (`https://api.openai.com/v1`).
    pub base_url: String,
    pub model: String,
    /// A key is stored; its value never leaves Rust.
    pub has_key: bool,
}

/// A chat under way, removed however it ends (the window may drop the call midway).
struct Running(u32);

impl Running {
    fn new(request: u32) -> (Self, oneshot::Receiver<()>) {
        let (tx, rx) = oneshot::channel();
        RUNNING.locked().get_or_insert_with(HashMap::new).insert(request, tx);
        (Running(request), rx)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Some(running) = RUNNING.locked().as_mut() {
            running.remove(&self.0);
        }
    }
}

fn stored_key(app: &AppHandle) -> Option<String> {
    credentials::read(&app.config().identifier, KEYRING_ACCOUNT).ok().flatten()
}

fn settings_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join(FILE))
}

fn load(app: &AppHandle) -> Saved {
    settings_file(app).ok().map(|p| files::load_or_default(&p)).unwrap_or_default()
}

fn view(app: &AppHandle) -> AnalystSettings {
    let saved = load(app);
    AnalystSettings { base_url: saved.base_url, model: saved.model, has_key: stored_key(app).is_some() }
}

/// HTTPS, or plain HTTP on this computer (a local model server). Anything else could send the
/// key in the clear to a host that is not the user's provider.
fn endpoint(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Set the analyst's API base URL first.".into());
    }
    let loopback = base.strip_prefix("http://").is_some_and(|rest| {
        let authority = rest.split('/').next().unwrap_or("");
        if authority.starts_with("[::1]") {
            return true;
        }
        let host = authority.split(':').next().unwrap_or("");
        matches!(host, "127.0.0.1" | "localhost")
    });
    if !base.starts_with("https://") && !loopback {
        return Err("The analyst's base URL must use HTTPS (or HTTP on 127.0.0.1 for a local model).".into());
    }
    Ok(format!("{base}/chat/completions"))
}

fn server_error(status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().or(v["error"].as_str()).or(v["message"].as_str()).map(String::from))
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("The analyst's provider answered {status}: {msg}")
}

/// The window's analyst settings (base URL, model, whether a key is stored).
#[tauri::command]
#[specta::specta]
pub fn analyst_settings(app: AppHandle) -> AnalystSettings {
    view(&app)
}

/// Save the base URL and model; a non-empty `api_key` replaces the stored key.
#[tauri::command]
#[specta::specta]
pub fn analyst_set_settings(app: AppHandle, base_url: String, model: String, api_key: Option<String>) -> Result<AnalystSettings, String> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    endpoint(&base)?;
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("Set the analyst's model first.".into());
    }
    if model.len() > 200 || model.chars().any(char::is_whitespace) {
        return Err("The analyst's model name holds no spaces.".into());
    }
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        credentials::write(&app.config().identifier, KEYRING_ACCOUNT, key.trim())
            .map_err(|e| format!("credential store: {e}"))?;
    }
    files::save_json(&settings_file(&app)?, &Saved { base_url: base, model }).map_err(|e| e.to_string())?;
    Ok(view(&app))
}

/// Remove the stored key (the base URL and model stay).
#[tauri::command]
#[specta::specta]
pub fn analyst_clear_key(app: AppHandle) -> Result<AnalystSettings, String> {
    credentials::delete(&app.config().identifier, KEYRING_ACCOUNT).map_err(|e| format!("credential store: {e}"))?;
    Ok(view(&app))
}

/// One analysis: `messages` is the OpenAI-compatible message array the window built (with the
/// screenshot as a data URL). Every streamed event is sent on `on_event` (its JSON text).
#[tauri::command]
#[specta::specta]
pub async fn analyst_analyze(app: AppHandle, request: u32, messages: String, on_event: Channel<String>) -> Result<(), String> {
    if messages.len() > MAX_BODY {
        return Err("The chart image is too large to send (16 MB at most).".into());
    }
    let parsed: serde_json::Value = serde_json::from_str(&messages).map_err(|e| format!("The messages are not JSON: {e}"))?;
    if !parsed.is_array() {
        return Err("The messages must be an array.".into());
    }
    let saved = load(&app);
    let url = endpoint(&saved.base_url)?;
    // A local model server commonly has no authentication; a remote provider must have a key.
    let key = stored_key(&app);
    if key.is_none() && !url.starts_with("http://") {
        return Err("Set the analyst's API key in its settings.".into());
    }
    let body = serde_json::json!({
        "model": saved.model,
        "messages": parsed,
        "stream": true,
        "temperature": 0.2,
        "max_tokens": 1400,
    });
    let (_running, mut stop_rx) = Running::new(request);
    let mut req = CLIENT.get().post(&url).header("content-type", "application/json");
    if let Some(key) = key {
        req = req.header("authorization", format!("Bearer {key}"));
    }
    let req = req.json(&body);
    let mut res = tokio::select! {
        r = req.send() => r.map_err(|e| format!("The analyst's provider did not answer: {e}"))?,
        _ = &mut stop_rx => return Ok(()),
    };
    let status = res.status();
    let streamed = res.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("event-stream"));
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(server_error(status.as_u16(), &text));
    }
    if !streamed {
        // A provider that answered whole: hand the window the same shape an event has.
        let text = res.text().await.unwrap_or_default();
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("The provider answered unreadable JSON: {e}"))?;
        on_event.send(value.to_string()).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut buf = Vec::new();
    loop {
        let chunk = tokio::select! {
            c = res.chunk() => c.map_err(|e| format!("The answer stopped: {e}"))?,
            _ = &mut stop_rx => return Ok(()),
        };
        let Some(bytes) = chunk else { break };
        buf.extend_from_slice(&bytes);
        while let Some(line) = crate::assistant::next_line(&mut buf) {
            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data == "[DONE]" {
                    return Ok(());
                }
                if !data.is_empty() {
                    on_event.send(data.to_string()).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

/// Stop an analysis under way (its answer so far stays).
#[tauri::command]
#[specta::specta]
pub fn analyst_cancel(request: u32) {
    if let Some(tx) = RUNNING.locked().as_mut().and_then(|running| running.remove(&request)) {
        let _ = tx.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_requires_https_or_a_loopback_host() {
        assert_eq!(endpoint("https://api.openai.com/v1/").unwrap(), "https://api.openai.com/v1/chat/completions");
        assert_eq!(endpoint("http://127.0.0.1:8080/v1").unwrap(), "http://127.0.0.1:8080/v1/chat/completions");
        assert_eq!(endpoint("http://localhost:11434").unwrap(), "http://localhost:11434/chat/completions");
        assert!(endpoint("http://localhost.example.com/v1").is_err());
        assert!(endpoint("http://127.0.0.1.example.com/v1").is_err());
        assert!(endpoint("ftp://example.com").is_err());
        assert!(endpoint(" ").is_err());
    }

    #[test]
    fn a_saved_provider_reads_with_defaults() {
        let saved: Saved = serde_json::from_str("{}").unwrap();
        assert!(saved.base_url.is_empty() && saved.model.is_empty());
        let saved: Saved = serde_json::from_str(r#"{"baseUrl":"https://x","model":"m"}"#).unwrap();
        assert_eq!((saved.base_url.as_str(), saved.model.as_str()), ("https://x", "m"));
    }
}

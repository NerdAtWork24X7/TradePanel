//! Provider settings and the generated `models.json`.
//!
//! The window's form stays a base URL, a model id and an API key. Pi needs a
//! provider descriptor, so the host writes one into its agent directory:
//! `tradepanel` speaks `openai-completions` at the user's URL, and its key is
//! an environment reference (`$TRADEPANEL_API_KEY`) — the secret never enters
//! `models.json`, the snapshot or the webview.
//!
//! Settings keep the pre-Pi file name (`analyst.json`) and keyring account, so
//! a saved provider survives the change of engine.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;
use tauri::{AppHandle, Manager};

pub const FILE: &str = "analyst.json";
pub const KEYRING_ACCOUNT: &str = "analyst-api-key";
pub const KEY_ENV: &str = "TRADEPANEL_API_KEY";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Saved {
    pub base_url: String,
    pub model: String,
}

fn settings_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join(FILE))
}

pub fn load(app: &AppHandle) -> Saved {
    settings_file(app)
        .ok()
        .map(|path| opentrader_core::files::load_or_default(&path))
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, saved: &Saved) -> Result<(), String> {
    opentrader_core::files::save_json(&settings_file(app)?, saved).map_err(|e| e.to_string())
}

pub fn key(app: &AppHandle) -> Option<String> {
    crate::credentials::read(&app.config().identifier, KEYRING_ACCOUNT).ok().flatten()
}

pub fn set_key(app: &AppHandle, key: &str) -> Result<(), String> {
    crate::credentials::write(&app.config().identifier, KEYRING_ACCOUNT, key)
        .map_err(|e| format!("credential store: {e}"))
}

pub fn clear_key(app: &AppHandle) -> Result<(), String> {
    crate::credentials::delete(&app.config().identifier, KEYRING_ACCOUNT)
        .map_err(|e| format!("credential store: {e}"))
}

/// Whether a URL points at this computer. A local model server commonly has no
/// authentication; a remote host must use HTTPS with a stored key.
pub fn is_loopback(base: &str) -> bool {
    let base = base.trim();
    base.strip_prefix("http://").is_some_and(|rest| {
        let authority = rest.split('/').next().unwrap_or("");
        if authority.starts_with("[::1]") {
            return true;
        }
        matches!(authority.split(':').next().unwrap_or(""), "127.0.0.1" | "localhost")
    })
}

/// A base URL, as Pi's provider needs it. The old direct analyst asked for the
/// full `/chat/completions` endpoint; Pi appends that path itself, so a stored
/// legacy endpoint is trimmed back to its base instead of doubled.
pub fn normalize_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    let lowered = trimmed.to_ascii_lowercase();
    for suffix in ["/chat/completions", "/completions"] {
        if lowered.ends_with(suffix) {
            return trimmed[..trimmed.len() - suffix.len()].trim_end_matches('/').to_string();
        }
    }
    trimmed.to_string()
}

/// HTTPS, or plain HTTP on this computer (a local model server). Anything else
/// could send the key in the clear to a host that is not the user's provider.
pub fn endpoint(base: &str) -> Result<String, String> {
    let base = normalize_base(base);
    if base.is_empty() {
        return Err("Set the analyst's API base URL first.".into());
    }
    if !base.starts_with("https://") && !is_loopback(&base) {
        return Err("The analyst's base URL must use HTTPS (or HTTP on 127.0.0.1 for a local model).".into());
    }
    Ok(base)
}

pub fn validate_model(model: &str) -> Result<String, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("Set the analyst's model first.".into());
    }
    if model.len() > 200 || model.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The analyst's model id holds no spaces or control characters.".into());
    }
    Ok(model.to_string())
}

/// Write Pi's provider catalogue for the saved endpoint. `has_key` selects the
/// environment reference; a keyless loopback server gets the conventional
/// dummy key its API ignores.
pub fn write_models(agent_dir: &Path, base_url: &str, model: &str, has_key: bool) -> Result<(), String> {
    let base = endpoint(base_url)?;
    let model = validate_model(model)?;
    if !has_key && !is_loopback(&base) {
        return Err("Set the analyst's API key in its settings.".into());
    }
    let api_key = if has_key { format!("${KEY_ENV}") } else { "local".to_string() };
    let models = json!({
        "$schema": "https://pi.dev/schemas/models.schema.json",
        "providers": {
            "tradepanel": {
                "name": "TradePanel provider",
                "baseUrl": base,
                "api": "openai-completions",
                "apiKey": api_key,
                "authHeader": true,
                "models": [{
                    "id": model,
                    "name": model,
                    "input": ["text", "image"],
                    "reasoning": false,
                    "contextWindow": 128000,
                    "maxTokens": 8192,
                    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                    // Bound a chart screenshot before it enters conversation
                    // history: ~1568 px and 400 KB base64 is plenty for structure.
                    "inputLimits": {"images": {"resize": {"maxWidth": 1568, "maxHeight": 1568, "maxBytes": 400000, "jpegQuality": 82}}}
                }]
            }
        }
    });
    let bytes = serde_json::to_vec_pretty(&models).map_err(|e| e.to_string())?;
    let path = agent_dir.join("models.json");
    opentrader_core::files::write_atomic(&path, &bytes)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_legacy_completion_endpoint_is_trimmed_to_its_base() {
        assert_eq!(
            normalize_base("https://opencode.ai/inference/go/openai/v1/chat/completions"),
            "https://opencode.ai/inference/go/openai/v1"
        );
        assert_eq!(normalize_base("https://api.openai.com/v1/chat/completions/"), "https://api.openai.com/v1");
        assert_eq!(normalize_base("https://api.openai.com/v1/"), "https://api.openai.com/v1");
        assert_eq!(
            endpoint("https://opencode.ai/inference/go/openai/v1/chat/completions").unwrap(),
            "https://opencode.ai/inference/go/openai/v1"
        );
        // A local server written as its completion endpoint works too.
        assert_eq!(endpoint("http://127.0.0.1:11434/v1/chat/completions").unwrap(), "http://127.0.0.1:11434/v1");
    }

    #[test]
    fn only_https_or_loopback_http_is_accepted() {
        assert_eq!(endpoint("https://api.openai.com/v1/").unwrap(), "https://api.openai.com/v1");
        assert_eq!(endpoint("http://127.0.0.1:11434/v1").unwrap(), "http://127.0.0.1:11434/v1");
        assert_eq!(endpoint("http://localhost:8080/v1").unwrap(), "http://localhost:8080/v1");
        assert_eq!(endpoint("http://[::1]:8080/v1").unwrap(), "http://[::1]:8080/v1");
        assert!(endpoint("http://localhost.example.com/v1").is_err());
        assert!(endpoint("http://127.0.0.1.example.com/v1").is_err());
        assert!(endpoint("ftp://example.com").is_err());
        assert!(endpoint(" ").is_err());
    }

    #[test]
    fn model_ids_allow_slashes_but_not_spaces() {
        assert!(validate_model("gpt-4o-mini").is_ok());
        assert!(validate_model("meta-llama/Llama-3.1-70B").is_ok());
        assert!(validate_model("qwen2.5-coder:7b").is_ok());
        assert!(validate_model("").is_err());
        assert!(validate_model("two words").is_err());
        assert!(validate_model("tab\there").is_err());
    }

    #[test]
    fn models_json_references_the_key_never_embeds_it() {
        let dir = std::env::temp_dir().join(format!("opentrader-models-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_models(&dir, "https://api.example.com/v1", "vision-model", true).unwrap();
        let text = std::fs::read_to_string(dir.join("models.json")).unwrap();
        assert!(text.contains("\"apiKey\": \"$TRADEPANEL_API_KEY\""));
        assert!(text.contains("\"baseUrl\": \"https://api.example.com/v1\""));
        assert!(text.contains("\"input\": [\n"));
        assert!(!text.contains("sk-"));
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["providers"]["tradepanel"]["models"][0]["id"], "vision-model");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_remote_endpoint_without_a_key_is_refused() {
        let dir = std::env::temp_dir().join(format!("opentrader-models-nokey-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let err = write_models(&dir, "https://api.example.com/v1", "m", false).unwrap_err();
        assert!(err.contains("API key"), "{err}");
        // A local server may legitimately have no key.
        write_models(&dir, "http://127.0.0.1:11434/v1", "m", false).unwrap();
        let text = std::fs::read_to_string(dir.join("models.json")).unwrap();
        assert!(text.contains("\"apiKey\": \"local\""));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

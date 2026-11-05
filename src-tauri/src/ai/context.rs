//! Validation and atomic persistence of the read-only analysis snapshot.
//!
//! The WebView is trusted, but the snapshot is the only data the model can
//! reach through the extension tools. Keep it bounded, free of credential-like
//! values, and written atomically so a tool never reads a partial file.

use std::fs;
use std::path::Path;

use serde_json::Value;

use super::paths::restrict;

pub const MAX_SNAPSHOT_BYTES: usize = 1_500_000;
pub const MAX_IMAGES: usize = 4;
pub const MAX_IMAGE_CHARS: usize = 3_000_000;
pub const MAX_IMAGE_TOTAL_CHARS: usize = 5_000_000;

const ALLOWED_TOP_LEVEL: [&str; 9] = [
    "version",
    "capturedAtMs",
    "instrument",
    "chart",
    "analysis",
    "indicators",
    "portfolio",
    "ticket",
    "generatedBy",
];

const FORBIDDEN_KEY_PARTS: [&str; 9] = [
    "privatekey",
    "private_key",
    "api_key",
    "apikey",
    "secret",
    "password",
    "token",
    "authorization",
    "credential",
];

pub struct PromptImage {
    pub data: String,
    pub mime_type: &'static str,
}

impl PromptImage {
    pub fn to_wire(&self) -> Value {
        serde_json::json!({
            "type": "image",
            "data": self.data,
            "mimeType": self.mime_type,
        })
    }
}

/// Validate the snapshot and write it atomically with user-only permissions.
pub fn write_snapshot(path: &Path, snapshot: &Value) -> Result<usize, String> {
    validate_snapshot(snapshot)?;
    let payload = serde_json::to_vec(snapshot)
        .map_err(|error| format!("cannot serialise snapshot: {error}"))?;
    if payload.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!(
            "Analysis snapshot is too large ({} bytes, limit {MAX_SNAPSHOT_BYTES})",
            payload.len()
        ));
    }
    let tmp = path.with_extension("json.tmp");
    let write = || -> std::io::Result<()> {
        fs::write(&tmp, &payload)?;
        restrict(&tmp, 0o600);
        fs::rename(&tmp, path)
    };
    if let Err(error) = write() {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot write analysis context: {error}"));
    }
    Ok(payload.len())
}

pub fn validate_snapshot(snapshot: &Value) -> Result<(), String> {
    let object = snapshot
        .as_object()
        .ok_or_else(|| "Analysis snapshot must be a JSON object".to_string())?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Analysis snapshot version must be 1".to_string());
    }
    let captured = object
        .get("capturedAtMs")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "Analysis snapshot needs a capturedAtMs timestamp".to_string())?;
    if captured < 1_600_000_000_000.0 {
        return Err("Analysis snapshot timestamp is not in milliseconds".to_string());
    }
    for key in object.keys() {
        if !ALLOWED_TOP_LEVEL.contains(&key.as_str()) {
            return Err(format!("Unexpected snapshot field: {key}"));
        }
    }
    if object
        .get("instrument")
        .and_then(Value::as_object)
        .is_none()
    {
        return Err("Analysis snapshot is missing its instrument".to_string());
    }
    scan(snapshot, 0)?;
    Ok(())
}

fn scan(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 10 {
        return Err("Analysis snapshot is nested too deeply".to_string());
    }
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let lowered = key.to_ascii_lowercase().replace(['-', ' '], "_");
                let compact = lowered.replace('_', "");
                if FORBIDDEN_KEY_PARTS
                    .iter()
                    .any(|needle| compact.contains(&needle.replace('_', "")))
                {
                    return Err(format!(
                        "Analysis snapshot must not contain credential-like field '{key}'"
                    ));
                }
                scan(child, depth + 1)?;
            }
        }
        Value::Array(items) => {
            if items.len() > 1200 {
                return Err("Analysis snapshot contains an oversized array".to_string());
            }
            for item in items {
                scan(item, depth + 1)?;
            }
        }
        Value::String(text) => {
            if text.len() > 4096 {
                return Err("Analysis snapshot contains an oversized string".to_string());
            }
            if looks_like_secret(text) {
                return Err(
                    "Analysis snapshot contains a value that looks like a credential".to_string(),
                );
            }
        }
        _ => {}
    }
    Ok(())
}

fn looks_like_secret(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.len() >= 66 && trimmed.starts_with("0x") {
        let hex = &trimmed[2..];
        if hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return true;
        }
    }
    let lower = trimmed.to_ascii_lowercase();
    (trimmed.len() >= 24 && lower.starts_with("sk-"))
        || (trimmed.len() >= 32 && lower.starts_with("ghp_"))
}

/// Validate base64 PNG attachments and return Pi's image wire format.
pub fn validate_images(images: &[String]) -> Result<Vec<PromptImage>, String> {
    if images.len() > MAX_IMAGES {
        return Err(format!("At most {MAX_IMAGES} charts can be attached"));
    }
    let mut total = 0usize;
    let mut out = Vec::with_capacity(images.len());
    for (index, data) in images.iter().enumerate() {
        let data = data.trim();
        if data.is_empty() {
            return Err(format!("Chart {} is empty", index + 1));
        }
        if data.len() > MAX_IMAGE_CHARS {
            return Err(format!("Chart {} exceeds the size limit", index + 1));
        }
        if data.contains("data:") || !data.is_ascii() {
            return Err(format!("Chart {} must be raw base64", index + 1));
        }
        if !data
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        {
            return Err(format!("Chart {} is not valid base64", index + 1));
        }
        // PNG signature: 89 50 4E 47 0D 0A 1A 0A -> iVBORw0KGgo...
        if !data.starts_with("iVBORw0KGgo") {
            return Err(format!("Chart {} is not a PNG image", index + 1));
        }
        total += data.len();
        if total > MAX_IMAGE_TOTAL_CHARS {
            return Err("Attached charts exceed the total size limit".to_string());
        }
        out.push(PromptImage {
            data: data.to_string(),
            mime_type: "image/png",
        });
    }
    Ok(out)
}

/// Remove inline image payloads from messages before they cross IPC or land in
/// UI state. History only needs to know that a chart was attached.
pub fn strip_image_payloads(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let is_image = map.get("type").and_then(Value::as_str) == Some("image");
            if is_image {
                if let Some(data) = map.get_mut("data") {
                    let length = data.as_str().map(str::len).unwrap_or(0);
                    *data = Value::String(String::new());
                    map.insert("omitted".to_string(), Value::Bool(length > 0));
                }
            }
            for child in map.values_mut() {
                strip_image_payloads(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_image_payloads(item);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value {
        serde_json::json!({
            "version": 1,
            "capturedAtMs": 1_800_000_000_000u64,
            "instrument": { "symbol": "BTC/USDT", "exchange": "binance", "market": "spot" },
            "analysis": { "timeframes": ["1d", "4h", "5m"] },
            "indicators": { "values": { "rsi14": 55.2 } },
            "ticket": { "direction": "long", "limit": "64000" }
        })
    }

    #[test]
    fn accepts_a_compact_snapshot() {
        validate_snapshot(&snapshot()).unwrap();
    }

    #[test]
    fn rejects_credentials_unknown_fields_and_bad_timestamps() {
        let mut secret = snapshot();
        secret["ticket"]["api_key"] = Value::String("x".into());
        assert!(validate_snapshot(&secret)
            .unwrap_err()
            .contains("credential"));

        let mut hex = snapshot();
        hex["instrument"]["note"] = Value::String(format!("0x{}", "ab".repeat(32)));
        assert!(validate_snapshot(&hex).unwrap_err().contains("credential"));

        let mut extra = snapshot();
        extra["debug"] = Value::Bool(true);
        assert!(validate_snapshot(&extra)
            .unwrap_err()
            .contains("Unexpected"));

        let mut stamp = snapshot();
        stamp["capturedAtMs"] = Value::from(1_800_000_000u64);
        assert!(validate_snapshot(&stamp).is_err());
    }

    #[test]
    fn writes_atomically_and_rejects_oversized_files() {
        let base = std::env::temp_dir().join(format!(
            "tradepanel-ai-context-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("context.json");
        let bytes = write_snapshot(&path, &snapshot()).unwrap();
        assert!(bytes > 0);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("BTC/USDT"));
        assert!(!base.join("context.json.tmp").exists());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn image_validation_requires_png_and_bounds() {
        let png = format!("iVBORw0KGgo{}", "A".repeat(32));
        let images = validate_images(std::slice::from_ref(&png)).unwrap();
        assert_eq!(images[0].mime_type, "image/png");
        assert_eq!(images[0].data, png);
        let wire = images[0].to_wire();
        assert_eq!(wire["type"], "image");
        assert_eq!(wire["data"], png, "the full base64 payload must reach Pi");
        assert_eq!(wire["mimeType"], "image/png");
        assert!(validate_images(&["data:image/png;base64,AAAA".to_string()]).is_err());
        assert!(validate_images(&["/9j/4AAQSkZJRg==".to_string()]).is_err());
        assert!(validate_images(&vec![png; MAX_IMAGES + 1]).is_err());
    }

    #[test]
    fn image_payloads_are_stripped_for_history() {
        let mut message = serde_json::json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "analyse" },
                { "type": "image", "data": "AAAA", "mimeType": "image/png" }
            ]
        });
        strip_image_payloads(&mut message);
        assert_eq!(message["content"][1]["data"], "");
        assert_eq!(message["content"][1]["omitted"], true);
        assert_eq!(message["content"][0]["text"], "analyse");
    }
}

//! Validation and atomic persistence of the read-only analysis snapshot.
//!
//! The WebView is trusted, but the snapshot is the only data the model can
//! reach through the extension tools. Keep it bounded, free of
//! credential-shaped values, and written atomically so a tool never reads a
//! partial file. Images travel separately on the `prompt` record, never inside
//! the snapshot.

use serde_json::{json, Value};
use std::path::Path;

pub const MAX_SNAPSHOT_BYTES: usize = 1_500_000;
pub const MAX_IMAGES: usize = 4;
pub const MAX_IMAGE_CHARS: usize = 3_000_000;
pub const MAX_IMAGE_TOTAL_CHARS: usize = 5_000_000;

/// The fields the analysis extension reads; anything else is a bug or an
/// attempt to smuggle content into the model's context.
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

const FORBIDDEN_KEY_PARTS: [&str; 10] = [
    "privatekey",
    "private_key",
    "api_key",
    "apikey",
    "secret",
    "password",
    "token",
    "authorization",
    "credential",
    "passphrase",
];

const MIME_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];

/// Validate the snapshot and write it atomically with user-only permissions.
pub fn write_snapshot(path: &Path, snapshot: &Value) -> Result<usize, String> {
    validate_snapshot(snapshot)?;
    let payload = serde_json::to_vec(snapshot).map_err(|e| format!("cannot serialise snapshot: {e}"))?;
    if payload.len() > MAX_SNAPSHOT_BYTES {
        return Err(format!(
            "The analysis snapshot is too large ({} bytes, limit {MAX_SNAPSHOT_BYTES}).",
            payload.len()
        ));
    }
    opentrader_core::files::write_atomic(path, &payload)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(payload.len())
}

pub fn validate_snapshot(snapshot: &Value) -> Result<(), String> {
    let object = snapshot
        .as_object()
        .ok_or_else(|| "The analysis snapshot must be a JSON object.".to_string())?;
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("The analysis snapshot version must be 1.".into());
    }
    let captured = object
        .get("capturedAtMs")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| "The analysis snapshot needs a capturedAtMs timestamp.".to_string())?;
    if captured < 1_600_000_000_000.0 {
        return Err("The analysis snapshot timestamp is not in milliseconds.".into());
    }
    for key in object.keys() {
        if !ALLOWED_TOP_LEVEL.contains(&key.as_str()) {
            return Err(format!("Unexpected analysis snapshot field: {key}"));
        }
    }
    if object.get("instrument").and_then(Value::as_object).is_none() {
        return Err("The analysis snapshot is missing its instrument.".into());
    }
    scan(snapshot, 0)
}

fn scan(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 10 {
        return Err("The analysis snapshot is nested too deeply.".into());
    }
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let lowered = key.to_ascii_lowercase().replace(['-', ' '], "_");
                if FORBIDDEN_KEY_PARTS.iter().any(|part| lowered.contains(part)) {
                    return Err(format!("The analysis snapshot must not carry '{key}'."));
                }
                scan(child, depth + 1)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            if items.len() > 5000 {
                return Err("The analysis snapshot holds an oversized array.".into());
            }
            for item in items {
                scan(item, depth + 1)?;
            }
            Ok(())
        }
        Value::String(text) => {
            if text.len() > MAX_SNAPSHOT_BYTES {
                return Err("The analysis snapshot holds an oversized string.".into());
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Parse the window's images (data URLs or `{data, mimeType}`) into Pi's
/// `ImageContent` records, with hard per-image and total caps.
pub fn parse_images(value: &Value) -> Result<Vec<Value>, String> {
    let Some(items) = value.as_array() else {
        if value.is_null() {
            return Ok(Vec::new());
        }
        return Err("The analysis images must be an array.".into());
    };
    if items.len() > MAX_IMAGES {
        return Err(format!("At most {MAX_IMAGES} chart images can be attached."));
    }
    let mut out = Vec::with_capacity(items.len());
    let mut total = 0usize;
    for item in items {
        let (data, mime) = match item {
            Value::String(url) => parse_data_url(url).ok_or_else(|| {
                "A chart image is not a data:image/(png|jpeg|webp);base64 URL.".to_string()
            })?,
            Value::Object(map) => {
                let data = map
                    .get("data")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "A chart image is missing its base64 data.".to_string())?;
                let mime = map
                    .get("mimeType")
                    .or_else(|| map.get("mime_type"))
                    .and_then(Value::as_str)
                    .unwrap_or("image/png")
                    .to_ascii_lowercase();
                (data.to_string(), mime)
            }
            _ => return Err("A chart image must be a data URL or a {data, mimeType} object.".into()),
        };
        if !MIME_TYPES.contains(&mime.as_str()) {
            return Err(format!("Unsupported chart image type: {mime}"));
        }
        if data.is_empty() || !data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') {
            return Err("A chart image is not valid base64.".into());
        }
        if data.len() > MAX_IMAGE_CHARS {
            return Err("A chart image is too large (3 MB of base64 at most).".into());
        }
        total += data.len();
        if total > MAX_IMAGE_TOTAL_CHARS {
            return Err("The chart images are too large together (5 MB of base64 at most).".into());
        }
        out.push(json!({ "type": "image", "data": data, "mimeType": mime }));
    }
    Ok(out)
}

fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mut parts = meta.split(';');
    let mime = parts.next()?.trim().to_ascii_lowercase();
    if !parts.any(|p| p.eq_ignore_ascii_case("base64")) {
        return None;
    }
    Some((data.to_string(), mime))
}

/// Replace image payloads in a forwarded message: the window already shows
/// the chart, and a 3 MB base64 blob has no place in the event stream.
pub fn strip_images(message: &mut Value) {
    let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("image") {
            if let Some(map) = block.as_object_mut() {
                map.remove("data");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value {
        json!({
            "version": 1,
            "capturedAtMs": 1_763_000_000_000u64,
            "generatedBy": "OpenTrader",
            "instrument": {"symbol": "BINANCE:BTC/USDT", "timeframe": "5m", "price": 100.5},
            "analysis": {"timeframes": ["1d", "4h", "5m"]},
            "indicators": {"summary": {"bias": "up"}, "perTimeframe": {}},
            "portfolio": {"enabled": false},
            "ticket": {"side": "buy"}
        })
    }

    /// The shape `buildAnalystSnapshot` produces (src/data/analyst-context.ts).
    fn window_snapshot() -> Value {
        json!({
            "version": 1,
            "capturedAtMs": 1_763_000_000_000u64,
            "generatedBy": "OpenTrader",
            "instrument": {"symbol": "BINANCE:BTC/USDT", "exchange": "BINANCE", "market": "spot", "timeframe": "5", "price": 100.5},
            "chart": {
                "title": "BINANCE:BTC/USDT, 5",
                "interval": "5",
                "studies": [{"id": "rsi", "title": "RSI", "inputs": "14", "plots": [{"plot": 0, "value": 55.2}]}],
                "timeframes": ["1d", "4h", "5m"],
                "missing": [{"timeframe": "4h", "error": "no data"}]
            },
            "analysis": {"timeframes": ["1d", "5m"], "chartTimeframe": "5", "notes": ["Computed by OpenTrader with the studies the user's chart shows."]},
            "indicators": {
                "available": ["RSI"],
                "unavailable": ["EMA: 1d: no value"],
                "summary": {"studies": ["RSI", "EMA"], "note": "the user's chart studies, recomputed on each timeframe"},
                "perTimeframe": {"5m": {"bars": 300, "close": 100.5, "changePct": 1.2, "studies": [{"id": "rsi", "title": "RSI", "plots": [{"plot": 0, "title": "RSI", "value": 55.2}]}]}},
                "levels": {"last": 100.5, "support": [98.0], "resistance": [103.0],
                    "priorDay": {"high": 112, "low": 98, "close": 110, "pivot": 106.67, "r1": 115.33, "s1": 101.33},
                    "timeframes": {"1d": {"high": 112, "low": 98}, "5m": {"high": 103, "low": 98}}}
            },
            "portfolio": {"enabled": true, "position": {"side": "buy", "qty": 0.5, "avgPrice": 99, "unrealizedPnl": 1.2, "takeProfit": null, "stopLoss": null}, "openOrders": [], "balance": {"currency": "USDT", "balance": 1000, "equity": 1001, "unrealizedPnl": 1.2, "isDemo": true}},
            "ticket": {"side": "buy", "qty": null, "orderType": "limit", "risk": 100, "limitPrice": 100, "takeProfit": 103, "stopLoss": 98, "editing": null}
        })
    }

    #[test]
    fn the_window_snapshot_is_accepted() {
        validate_snapshot(&window_snapshot()).expect("the window's own snapshot must validate");
    }

    #[test]
    fn a_well_formed_snapshot_is_written_atomically() {
        let dir = std::env::temp_dir().join(format!("opentrader-context-test-{}", std::process::id()));
        let path = dir.join("context.json");
        let bytes = write_snapshot(&path, &snapshot()).unwrap();
        assert!(bytes > 0);
        let read: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read["version"], 1);
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("context.json")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unexpected_fields_old_timestamps_and_secrets_are_refused() {
        let mut s = snapshot();
        s["extra"] = json!("nope");
        assert!(validate_snapshot(&s).unwrap_err().contains("Unexpected"));

        let mut s = snapshot();
        s["capturedAtMs"] = json!(1_600);
        assert!(validate_snapshot(&s).unwrap_err().contains("milliseconds"));

        let mut s = snapshot();
        s["instrument"]["api_key"] = json!("sk-live");
        assert!(validate_snapshot(&s).unwrap_err().contains("api_key"));

        let mut s = snapshot();
        s["portfolio"]["password"] = json!("hunter2");
        assert!(validate_snapshot(&s).unwrap_err().contains("password"));

        let mut s = snapshot();
        s["version"] = json!(2);
        assert!(validate_snapshot(&s).unwrap_err().contains("version"));
    }

    #[test]
    fn images_are_data_urls_or_objects_with_caps() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let images = parse_images(&json!([format!("data:image/png;base64,{png}")])).unwrap();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0]["type"], "image");
        assert_eq!(images[0]["mimeType"], "image/png");
        assert_eq!(images[0]["data"], png);

        let images = parse_images(&json!([{ "data": png, "mimeType": "image/jpeg" }])).unwrap();
        assert_eq!(images[0]["mimeType"], "image/jpeg");

        assert!(parse_images(&json!(["data:text/plain;base64,aGk="])).is_err());
        assert!(parse_images(&json!(["not a url"])).is_err());
        assert!(parse_images(&json!([{ "data": "***" }])).is_err());
        assert!(parse_images(&json!([1, 2])).is_err());
        let many: Vec<Value> = (0..=MAX_IMAGES).map(|_| json!(png)).collect();
        assert!(parse_images(&Value::Array(many)).is_err());
    }

    #[test]
    fn forwarded_images_lose_their_payload() {
        let mut message = json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "Analyze"},
                {"type": "image", "data": "AAAA", "mimeType": "image/png"}
            ]
        });
        strip_images(&mut message);
        assert_eq!(message["content"][1]["mimeType"], "image/png");
        assert!(message["content"][1].get("data").is_none());
    }
}

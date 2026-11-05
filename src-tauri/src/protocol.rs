//! JSON-RPC 2.0 wire types shared by the sidecar manager and the commands.
//!
//! One UTF-8 JSON object per line. The shell never trusts the sidecar blindly:
//! frames are size-limited, ids are normalised and only allow-listed methods
//! can be reached from the WebView.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

pub const ERR_PARSE: i64 = -32700;
pub const ERR_INVALID_REQUEST: i64 = -32600;
pub const ERR_INTERNAL: i64 = -32603;
pub const ERR_UNAVAILABLE: i64 = -32001;
pub const ERR_TIMEOUT: i64 = -32002;
pub const ERR_EXECUTION_UNKNOWN: i64 = -32004;
pub const ERR_DUPLICATE_REQUEST: i64 = -32012;
pub const ERR_PROTOCOL_MISMATCH: i64 = -32010;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RpcErrorPayload {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcErrorPayload {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(ERR_UNAVAILABLE, message)
    }

    pub fn timeout(method: &str, timeout_ms: u64) -> Self {
        Self::new(
            ERR_TIMEOUT,
            format!("Request timed out after {timeout_ms} ms"),
        )
        .with_data(serde_json::json!({ "method": method, "retryable": false }))
    }

    /// A timed-out or interrupted order may still have reached the exchange.
    pub fn execution_unknown(method: &str, detail: &str) -> Self {
        Self::new(
            ERR_EXECUTION_UNKNOWN,
            format!("Execution status unknown: {detail}"),
        )
        .with_data(serde_json::json!({
            "method": method,
            "retryable": false,
            "reconcile": "account.open_orders",
        }))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub state: String,
    pub message: Option<String>,
    pub protocol_version: Option<u32>,
    pub backend_version: Option<String>,
    pub pid: Option<u32>,
    pub attempts: u32,
    /// Monotonic emission time; lets the WebView discard out-of-order events.
    pub updated_at_ms: u64,
}

impl BackendStatus {
    pub fn new(state: &str) -> Self {
        Self {
            state: state.to_string(),
            message: None,
            protocol_version: None,
            backend_version: None,
            pid: None,
            attempts: 0,
            updated_at_ms: 0,
        }
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    pub fn with_pid(mut self, pid: u32) -> Self {
        self.pid = Some(pid);
        self
    }

    pub fn with_versions(mut self, protocol: u32, backend: impl Into<String>) -> Self {
        self.protocol_version = Some(protocol);
        self.backend_version = Some(backend.into());
        self
    }

    pub fn now(mut self) -> Self {
        self.updated_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        self
    }
}

#[derive(Debug, Clone)]
pub enum Incoming {
    Response {
        id: String,
        result: Result<Value, RpcErrorPayload>,
    },
    Notification {
        method: String,
        params: Value,
    },
    Invalid {
        id: Option<String>,
        error: RpcErrorPayload,
    },
    Ignored,
}

fn normalise_id(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() && text.len() <= 128 => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    }
}

/// Parse one response/notification frame received from the sidecar.
pub fn parse_incoming(line: &str) -> Incoming {
    if line.len() > MAX_MESSAGE_BYTES {
        return Incoming::Invalid {
            id: None,
            error: RpcErrorPayload::new(ERR_PARSE, "Frame exceeds the size limit"),
        };
    }
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => {
            return Incoming::Invalid {
                id: None,
                error: RpcErrorPayload::new(ERR_PARSE, "Malformed JSON from backend"),
            }
        }
    };
    let object = match value.as_object() {
        Some(object) => object,
        None => {
            return Incoming::Invalid {
                id: None,
                error: RpcErrorPayload::new(ERR_INVALID_REQUEST, "Frame must be an object"),
            }
        }
    };
    let id = normalise_id(object.get("id"));
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Incoming::Invalid {
            id,
            error: RpcErrorPayload::new(ERR_INVALID_REQUEST, "jsonrpc must be '2.0'"),
        };
    }
    if let Some(error) = object.get("error") {
        let Some(id) = id else {
            return Incoming::Invalid {
                id: None,
                error: RpcErrorPayload::new(ERR_INVALID_REQUEST, "Error frame without id"),
            };
        };
        return match serde_json::from_value::<RpcErrorPayload>(error.clone()) {
            Ok(payload) => Incoming::Response {
                id,
                result: Err(payload),
            },
            Err(_) => Incoming::Response {
                id,
                result: Err(RpcErrorPayload::new(
                    ERR_INTERNAL,
                    "Malformed error object from backend",
                )),
            },
        };
    }
    if let Some(result) = object.get("result") {
        let Some(id) = id else {
            return Incoming::Invalid {
                id: None,
                error: RpcErrorPayload::new(ERR_INVALID_REQUEST, "Result frame without id"),
            };
        };
        return Incoming::Response {
            id,
            result: Ok(result.clone()),
        };
    }
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        if method.is_empty() || method.len() > 120 {
            return Incoming::Invalid {
                id: None,
                error: RpcErrorPayload::new(ERR_INVALID_REQUEST, "Invalid notification method"),
            };
        }
        return Incoming::Notification {
            method: method.to_string(),
            params: object.get("params").cloned().unwrap_or(Value::Null),
        };
    }
    Incoming::Ignored
}

pub fn request_frame(id: &str, method: &str, params: &Value) -> Vec<u8> {
    let payload = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let mut bytes = serde_json::to_vec(&payload).unwrap_or_default();
    bytes.push(b'\n');
    bytes
}

/// Methods the WebView may call through `backend_rpc`.
///
/// Handshake, shutdown and credential mutation are deliberately excluded: they
/// are orchestrated by Rust only (`system.set_credentials` is sent internally).
pub const FRONTEND_METHODS: &[&str] = &[
    "market.meta",
    "market.get_candles",
    "market.get_tick",
    "market.search_symbols",
    "indicator.get_config",
    "indicator.save_config",
    "indicator.compute",
    "workspace.load",
    "workspace.save",
    "account.position",
    "account.open_orders",
    "trading.place_order",
    "trading.update_tp_sl",
    "trading.calc_qty",
    "trading.sz_decimals",
    "trading.coins",
    "alerts.get",
    "alerts.set",
    "settings.window_state.get",
    "settings.window_state.save",
];

pub fn is_frontend_method(method: &str) -> bool {
    FRONTEND_METHODS.contains(&method)
}

pub fn is_order_method(method: &str) -> bool {
    matches!(method, "trading.place_order" | "trading.update_tp_sl")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_result_and_error_responses() {
        match parse_incoming(r#"{"jsonrpc":"2.0","id":"rpc-1","result":{"ok":true}}"#) {
            Incoming::Response { id, result } => {
                assert_eq!(id, "rpc-1");
                assert_eq!(result.unwrap()["ok"], true);
            }
            other => panic!("unexpected: {other:?}"),
        }

        match parse_incoming(
            r#"{"jsonrpc":"2.0","id":"rpc-2","error":{"code":-32001,"message":"no creds"}}"#,
        ) {
            Incoming::Response { id, result } => {
                assert_eq!(id, "rpc-2");
                assert_eq!(result.unwrap_err().code, ERR_UNAVAILABLE);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn parses_notifications_and_rejects_malformed_frames() {
        match parse_incoming(r#"{"jsonrpc":"2.0","method":"event.credentials","params":{"n":1}}"#) {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "event.credentials");
                assert_eq!(params["n"], 1);
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert!(matches!(
            parse_incoming("not json"),
            Incoming::Invalid { .. }
        ));
        assert!(matches!(
            parse_incoming(r#"{"id":"1","result":{}}"#),
            Incoming::Invalid { .. }
        ));
        assert!(matches!(
            parse_incoming(r#"{"jsonrpc":"2.0","result":{}}"#),
            Incoming::Invalid { .. }
        ));
    }

    #[test]
    fn frontend_allowlist_excludes_privileged_methods() {
        assert!(is_frontend_method("market.get_candles"));
        assert!(is_frontend_method("trading.place_order"));
        for forbidden in [
            "system.hello",
            "system.shutdown",
            "system.set_credentials",
            "system.ping",
            "unknown.method",
        ] {
            assert!(
                !is_frontend_method(forbidden),
                "{forbidden} must not be callable"
            );
        }
    }

    #[test]
    fn order_timeouts_become_execution_unknown() {
        let error = RpcErrorPayload::execution_unknown("trading.place_order", "timeout");
        assert_eq!(error.code, ERR_EXECUTION_UNKNOWN);
        assert_eq!(error.data.unwrap()["retryable"], false);
    }

    #[test]
    fn request_frames_are_newline_delimited_and_bounded() {
        let frame = request_frame("rpc-9", "system.ping", &serde_json::json!({}));
        assert_eq!(*frame.last().unwrap(), b'\n');
        assert!(frame.len() < MAX_MESSAGE_BYTES);
    }
}

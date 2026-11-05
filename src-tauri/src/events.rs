//! Event names emitted to the WebView.

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::protocol::BackendStatus;

pub const STATUS_EVENT: &str = "backend:status";
pub const BACKEND_EVENT: &str = "backend:event";
pub const NOTICE_EVENT: &str = "app:notice";

pub fn emit_status(app: &AppHandle, status: &BackendStatus) {
    if let Err(error) = app.emit(STATUS_EVENT, status) {
        log::warn!("Cannot emit backend status: {error}");
    }
}

pub fn emit_backend_notification(app: &AppHandle, method: &str, params: serde_json::Value) {
    if let Err(error) = app.emit(
        BACKEND_EVENT,
        json!({ "method": method, "params": params }),
    ) {
        log::warn!("Cannot emit backend notification: {error}");
    }
}

pub fn emit_notice(app: &AppHandle, level: &str, message: &str) {
    if let Err(error) = app.emit(
        NOTICE_EVENT,
        json!({ "level": level, "message": message }),
    ) {
        log::warn!("Cannot emit notice: {error}");
    }
}

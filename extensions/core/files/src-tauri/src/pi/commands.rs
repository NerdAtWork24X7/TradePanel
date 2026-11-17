//! Thin command layer: the window talks to one managed `PiManager`.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use super::manager::{PiManager, PiStatus};
use super::update;

#[tauri::command]
#[specta::specta]
pub fn pi_status(manager: State<'_, Arc<PiManager>>) -> PiStatus {
    manager.status()
}

#[tauri::command]
#[specta::specta]
pub async fn pi_set_settings(
    manager: State<'_, Arc<PiManager>>,
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<PiStatus, String> {
    let manager = Arc::clone(manager.inner());
    manager.set_settings(base_url, model, api_key).await
}

#[tauri::command]
#[specta::specta]
pub async fn pi_clear_key(manager: State<'_, Arc<PiManager>>) -> Result<PiStatus, String> {
    let manager = Arc::clone(manager.inner());
    manager.clear_key().await
}

/// One Analyze chart request: a versioned context snapshot, the rendered chart
/// (data URLs), the prompt, and the event channel the run streams on.
#[tauri::command]
#[specta::specta]
pub async fn pi_analyze(
    manager: State<'_, Arc<PiManager>>,
    snapshot: String,
    images: String,
    message: String,
    on_event: Channel<String>,
) -> Result<(), String> {
    let manager = Arc::clone(manager.inner());
    let snapshot: Value =
        serde_json::from_str(&snapshot).map_err(|e| format!("The analysis snapshot is not JSON: {e}"))?;
    let images: Value =
        serde_json::from_str(&images).map_err(|e| format!("The analysis images are not JSON: {e}"))?;
    manager.analyze(snapshot, images, message, on_event).await
}

#[tauri::command]
#[specta::specta]
pub async fn pi_abort(manager: State<'_, Arc<PiManager>>) -> Result<(), String> {
    let manager = Arc::clone(manager.inner());
    manager.abort().await
}

/// Clear the conversation: the next analysis starts a new Pi session.
#[tauri::command]
#[specta::specta]
pub async fn pi_new_session(manager: State<'_, Arc<PiManager>>) -> Result<(), String> {
    let manager = Arc::clone(manager.inner());
    manager.new_session().await;
    Ok(())
}

/// Install the latest Pi into the user's runtime overlay. Progress lines are
/// sent on `on_event`; the returned status is the one the panel renders.
#[tauri::command]
#[specta::specta]
pub async fn pi_update(
    app: tauri::AppHandle,
    manager: State<'_, Arc<PiManager>>,
    on_event: Channel<String>,
) -> Result<PiStatus, String> {
    let manager = Arc::clone(manager.inner());
    update::run(&app, &manager, on_event).await?;
    Ok(manager.status())
}

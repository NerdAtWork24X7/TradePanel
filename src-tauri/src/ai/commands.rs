//! Tauri commands for AI Analysis.
//!
//! The WebView can start/stop the runtime, run analyses, manage conversations
//! and store a provider key. It cannot choose arbitrary Pi commands, tools,
//! session paths or filesystem locations.

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::commands::AppState;
use crate::protocol::RpcErrorPayload;

use super::auth::{AuthModel, AuthProviders, AuthSession};
use super::manager::{AiStatus, ConnectResult, Diagnostics, ProviderInfo};
use super::probe::ModelInfo;
use super::store::{AiSettings, ConversationStore};

#[tauri::command]
pub async fn ai_status(state: State<'_, AppState>) -> Result<AiStatus, RpcErrorPayload> {
    Ok(state.ai.status_fresh().await)
}

#[tauri::command]
pub async fn ai_providers(
    state: State<'_, AppState>,
) -> Result<Vec<ProviderInfo>, RpcErrorPayload> {
    let catalogue = state.ai.providers().await?;
    Ok(catalogue
        .providers
        .into_iter()
        .map(|provider| ProviderInfo {
            id: provider.id,
            label: provider.name,
        })
        .collect())
}

/// Provider catalogue + stored credential metadata straight from Pi's runtime.
#[tauri::command]
pub async fn ai_auth_providers(
    state: State<'_, AppState>,
) -> Result<AuthProviders, RpcErrorPayload> {
    state.ai.auth().providers().await
}

/// Every model the signed-in credentials unlock, with context/price metadata.
#[tauri::command]
pub async fn ai_auth_models(state: State<'_, AppState>) -> Result<Vec<AuthModel>, RpcErrorPayload> {
    state.ai.auth().models().await
}

#[tauri::command]
pub async fn ai_auth_start(
    state: State<'_, AppState>,
    provider: String,
    auth_type: String,
) -> Result<AuthSession, RpcErrorPayload> {
    let session = state.ai.auth().login_start(&provider, &auth_type).await?;
    state.ai.refresh_key_state().await;
    state.ai.emit_status();
    Ok(session)
}

#[tauri::command]
pub async fn ai_auth_answer(
    state: State<'_, AppState>,
    session_id: String,
    prompt_id: u32,
    value: String,
) -> Result<AuthSession, RpcErrorPayload> {
    let session = state
        .ai
        .auth()
        .login_answer(&session_id, prompt_id, &value)
        .await?;
    state.ai.refresh_key_state().await;
    state.ai.emit_status();
    Ok(session)
}

#[tauri::command]
pub async fn ai_auth_cancel(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<AuthSession, RpcErrorPayload> {
    state.ai.auth().login_cancel(&session_id).await
}

#[tauri::command]
pub async fn ai_auth_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<AuthSession, RpcErrorPayload> {
    state.ai.auth().login_get(&session_id).await
}

#[tauri::command]
pub async fn ai_auth_logout(
    state: State<'_, AppState>,
    provider: String,
) -> Result<AuthProviders, RpcErrorPayload> {
    let catalogue = state.ai.auth().logout(&provider).await?;
    state.ai.refresh_key_state().await;
    state.ai.emit_status();
    Ok(catalogue)
}

#[tauri::command]
pub async fn ai_diagnostics(state: State<'_, AppState>) -> Result<Diagnostics, RpcErrorPayload> {
    Ok(state.ai.diagnostics())
}

#[tauri::command]
pub async fn ai_connect(
    state: State<'_, AppState>,
    provider: String,
    api_key: String,
    model: Option<String>,
    thinking: Option<String>,
    portfolio_context: Option<bool>,
) -> Result<ConnectResult, RpcErrorPayload> {
    state
        .ai
        .connect(provider, api_key, model, thinking, portfolio_context)
        .await
}

#[tauri::command]
pub async fn ai_disconnect(state: State<'_, AppState>) -> Result<(), RpcErrorPayload> {
    state.ai.disconnect().await
}

#[tauri::command]
pub async fn ai_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, RpcErrorPayload> {
    state.ai.refresh_models().await
}

#[tauri::command]
pub async fn ai_save_preferences(
    state: State<'_, AppState>,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<String>,
    portfolio_context: Option<bool>,
) -> Result<AiSettings, RpcErrorPayload> {
    state
        .ai
        .save_preferences(provider, model, thinking, portfolio_context)
        .await
}

#[tauri::command]
pub async fn ai_send(
    state: State<'_, AppState>,
    message: String,
    snapshot: Value,
    images: Option<Vec<String>>,
) -> Result<Value, RpcErrorPayload> {
    state
        .ai
        .send(&message, &snapshot, images.as_deref().unwrap_or(&[]))
        .await
}

#[tauri::command]
pub async fn ai_abort(state: State<'_, AppState>) -> Result<(), RpcErrorPayload> {
    state.ai.abort().await
}

#[tauri::command]
pub async fn ai_stop(state: State<'_, AppState>) -> Result<(), RpcErrorPayload> {
    state.ai.stop().await
}

#[tauri::command]
pub async fn ai_history(state: State<'_, AppState>) -> Result<Value, RpcErrorPayload> {
    state.ai.history().await
}

#[tauri::command]
pub async fn ai_conversations(
    state: State<'_, AppState>,
) -> Result<ConversationStore, RpcErrorPayload> {
    Ok(state.ai.conversations())
}

#[tauri::command]
pub async fn ai_conversation_create(
    state: State<'_, AppState>,
) -> Result<ConversationStore, RpcErrorPayload> {
    state.ai.create_conversation().await
}

#[tauri::command]
pub async fn ai_conversation_activate(
    state: State<'_, AppState>,
    id: String,
) -> Result<ConversationStore, RpcErrorPayload> {
    state.ai.activate_conversation(&id).await
}

#[tauri::command]
pub async fn ai_conversation_rename(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<ConversationStore, RpcErrorPayload> {
    state.ai.rename_conversation(&id, &title).await
}

#[tauri::command]
pub async fn ai_conversation_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<ConversationStore, RpcErrorPayload> {
    state.ai.delete_conversation(&id).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRuntimeReport {
    pub runtime_ready: bool,
    pub runtime_error: Option<String>,
    pub node_version: Option<String>,
    pub pi_version: Option<String>,
}

/// Lightweight runtime probe used by the settings header (no process start).
#[tauri::command]
pub async fn ai_runtime_report(
    state: State<'_, AppState>,
) -> Result<AiRuntimeReport, RpcErrorPayload> {
    let diagnostics = state.ai.diagnostics();
    Ok(AiRuntimeReport {
        runtime_ready: diagnostics.runtime_ready,
        runtime_error: diagnostics.runtime_error,
        node_version: diagnostics.node_version,
        pi_version: diagnostics.pi_version,
    })
}

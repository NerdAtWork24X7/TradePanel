//! One-shot provider connectivity probe.
//!
//! Runs Pi in an ephemeral session (no conversation pollution) with the
//! candidate key, lists the provider's models, selects one, and asks a trivial
//! prompt. Success proves the key, endpoint, model and network all work before
//! the credential is stored.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;

use super::lines::{read_bounded_line, ReadLine, MAX_LINE_BYTES};
use super::paths::AiPaths;
use super::runtime::AiRuntime;
use super::spawn::{command, Launch};

const PROBE_TIMEOUT: Duration = Duration::from_secs(90);
const PROBE_PROMPT: &str = "Reply with the single word OK. Do not call any tools.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub reasoning: bool,
    pub input: Vec<String>,
}

#[derive(Debug)]
pub struct ProbeOutcome {
    pub models: Vec<ModelInfo>,
    pub model: String,
    pub reply: String,
}

pub async fn probe(
    runtime: &AiRuntime,
    paths: &AiPaths,
    provider: &str,
    key: &str,
    requested_model: Option<&str>,
) -> Result<ProbeOutcome, String> {
    tokio::time::timeout(
        PROBE_TIMEOUT,
        probe_inner(runtime, paths, provider, key, requested_model),
    )
    .await
    .map_err(|_| {
        format!(
            "Provider check timed out after {}s. Check the network, proxy and provider status.",
            PROBE_TIMEOUT.as_secs()
        )
    })?
}

async fn probe_inner(
    runtime: &AiRuntime,
    paths: &AiPaths,
    provider: &str,
    key: &str,
    requested_model: Option<&str>,
) -> Result<ProbeOutcome, String> {
    let launch = Launch {
        runtime,
        paths,
        provider,
        model: "",
        thinking: "medium",
        session_id: None,
        system_prompt: Some(
            "You are a connectivity probe for TradePanel. Reply with the single word OK. Do not use tools.",
        ),
    };
    let mut child = command(&launch, key)
        .spawn()
        .map_err(|error| format!("Cannot start the bundled AI runtime: {error}"))?;
    let stderr = child.stderr.take();
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "AI runtime has no stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "AI runtime has no stdout".to_string())?;
    let tail = Arc::new(Mutex::new(VecDeque::<String>::with_capacity(24)));
    if let Some(stderr) = stderr {
        let tail = tail.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::info!(target: "ai", "{}", line);
                let mut tail = tail.lock().unwrap();
                tail.push_back(line);
                if tail.len() > 24 {
                    tail.pop_front();
                }
            }
        });
    }

    let result = run_protocol(&mut child, &mut stdin, stdout, provider, requested_model).await;
    drop(stdin);
    let _ = child.start_kill();
    let _ = child.wait().await;
    match result {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            let tail = tail
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            Err(if tail.is_empty() {
                error
            } else {
                format!("{error}\nRuntime log:\n{tail}")
            })
        }
    }
}

async fn run_protocol(
    child: &mut Child,
    stdin: &mut tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    provider: &str,
    requested_model: Option<&str>,
) -> Result<ProbeOutcome, String> {
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut buffer = Vec::with_capacity(8 * 1024);

    write_command(
        stdin,
        json!({ "id": "probe-models", "type": "get_available_models" }),
    )
    .await?;
    let models_response = read_response(&mut reader, &mut buffer, child, "probe-models").await?;
    let models = parse_models(
        models_response.get("data").unwrap_or(&Value::Null),
        provider,
    );
    if models.is_empty() {
        return Err(format!(
            "No usable text models are available for provider '{provider}'. Check the API key, \
             provider permissions, or add a compatible endpoint in the AI agent models.json."
        ));
    }
    let model = match requested_model.filter(|value| !value.trim().is_empty()) {
        Some(requested) => {
            if !models.iter().any(|candidate| candidate.id == requested) {
                return Err(format!(
                    "Model '{requested}' is not available for provider '{provider}' with this key."
                ));
            }
            requested.to_string()
        }
        None => models
            .iter()
            .find(|candidate| candidate.input.iter().any(|input| input == "text"))
            .map(|candidate| candidate.id.clone())
            .unwrap_or_else(|| models[0].id.clone()),
    };

    write_command(
        stdin,
        json!({ "id": "probe-model", "type": "set_model", "provider": provider, "modelId": model }),
    )
    .await?;
    let selected = read_response(&mut reader, &mut buffer, child, "probe-model").await?;
    if selected.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(format!(
            "The provider rejected model '{model}': {}",
            selected
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }

    write_command(
        stdin,
        json!({
            "id": "probe-prompt",
            "type": "prompt",
            "message": PROBE_PROMPT,
        }),
    )
    .await?;
    let accepted = read_response(&mut reader, &mut buffer, child, "probe-prompt").await?;
    if accepted.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(format!(
            "The provider rejected the test prompt: {}",
            accepted
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }

    // Consume events until the run settles. Text deltas are a fallback for
    // providers that stream without a final message_end.
    let mut reply = String::new();
    let mut error: Option<String> = None;
    loop {
        let record = read_record(&mut reader, &mut buffer, child).await?;
        match record.get("type").and_then(Value::as_str) {
            Some("message_update") => {
                if let Some(delta) = record
                    .get("assistantMessageEvent")
                    .and_then(|event| event.get("delta"))
                    .and_then(Value::as_str)
                {
                    if reply.len() < 4096 {
                        reply.push_str(delta);
                    }
                }
            }
            Some("message_end") => {
                let message = record.get("message").cloned().unwrap_or(Value::Null);
                if message.get("role").and_then(Value::as_str) == Some("assistant") {
                    if message.get("stopReason").and_then(Value::as_str) == Some("error") {
                        error = message
                            .get("errorMessage")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                    }
                    if let Some(text) = text_of(&message) {
                        reply = text;
                    }
                }
            }
            Some("agent_settled") => break,
            _ => {}
        }
    }
    if let Some(error) = error {
        return Err(format!("The provider failed the test prompt: {error}"));
    }
    if reply.trim().is_empty() {
        return Err(
            "The provider accepted the request but returned no text. The model may be \
             misconfigured or the key may lack access."
                .to_string(),
        );
    }
    Ok(ProbeOutcome {
        models,
        model,
        reply,
    })
}

fn text_of(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let parts = content.as_array()?;
    let mut out = String::new();
    for part in parts {
        if part.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                out.push_str(text);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

pub fn parse_models(data: &Value, provider: &str) -> Vec<ModelInfo> {
    let Some(items) = data.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut models: Vec<ModelInfo> = items
        .iter()
        .filter(|item| item.get("provider").and_then(Value::as_str) == Some(provider))
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.to_string();
            Some(ModelInfo {
                name: item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string(),
                provider: provider.to_string(),
                context_window: item.get("contextWindow").and_then(Value::as_u64),
                max_tokens: item.get("maxTokens").and_then(Value::as_u64),
                reasoning: item
                    .get("reasoning")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                input: item
                    .get("input")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_else(|| vec!["text".to_string()]),
                id,
            })
        })
        .collect();
    models.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    models.dedup_by(|a, b| a.id == b.id);
    models.truncate(300);
    models
}

async fn write_command(stdin: &mut tokio::process::ChildStdin, value: Value) -> Result<(), String> {
    let mut frame = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    frame.push(b'\n');
    stdin
        .write_all(&frame)
        .await
        .map_err(|error| format!("Cannot write to the AI runtime: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("Cannot flush the AI runtime pipe: {error}"))
}

async fn read_response<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
    child: &mut Child,
    id: &str,
) -> Result<Value, String> {
    loop {
        let record = read_record(reader, buffer, child).await?;
        if record.get("type").and_then(Value::as_str) == Some("response")
            && record.get("id").and_then(Value::as_str) == Some(id)
        {
            if record.get("success").and_then(Value::as_bool) == Some(false) {
                return Err(format!(
                    "AI runtime rejected {id}: {}",
                    record
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                ));
            }
            return Ok(record);
        }
    }
}

async fn read_record<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
    child: &mut Child,
) -> Result<Value, String> {
    loop {
        match read_bounded_line(reader, buffer, MAX_LINE_BYTES).await {
            Ok(ReadLine::Line) => {
                let text = String::from_utf8_lossy(buffer);
                let text = text.trim_end_matches('\r').trim();
                if text.is_empty() {
                    continue;
                }
                return serde_json::from_str(text)
                    .map_err(|error| format!("Malformed AI runtime frame: {error}"));
            }
            Ok(ReadLine::Oversized) => {
                return Err("AI runtime produced an oversized frame".to_string())
            }
            Ok(ReadLine::Eof) => {
                let status = child.try_wait().ok().flatten();
                return Err(match status {
                    Some(status) => format!("AI runtime exited early ({status})"),
                    None => "AI runtime closed its output stream".to_string(),
                });
            }
            Err(error) => return Err(format!("Cannot read from the AI runtime: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_are_filtered_by_provider_and_deduplicated() {
        let data = json!({
            "models": [
                { "id": "a", "name": "Alpha", "provider": "openai", "input": ["text", "image"] },
                { "id": "a", "name": "Alpha duplicate", "provider": "openai", "input": ["text"] },
                { "id": "b", "name": "Beta", "provider": "anthropic", "input": ["text"] },
                { "id": "c", "name": "Gamma", "provider": "openai", "reasoning": true }
            ]
        });
        let models = parse_models(&data, "openai");
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|model| model.id == "a"));
        assert!(models.iter().any(|model| model.id == "c"));
        assert!(parse_models(&json!({}), "openai").is_empty());
    }

    #[test]
    fn assistant_text_is_flattened() {
        let message = json!({
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "hidden" },
                { "type": "text", "text": "OK" }
            ]
        });
        assert_eq!(text_of(&message).as_deref(), Some("OK"));
        assert!(text_of(&json!({ "role": "assistant", "content": [] })).is_none());
    }
}

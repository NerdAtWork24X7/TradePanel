//! AI-specific application data paths.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
pub struct AiPaths {
    pub root: PathBuf,
    pub agent: PathBuf,
    pub sessions: PathBuf,
    pub workspace: PathBuf,
    pub context_file: PathBuf,
    pub settings_file: PathBuf,
    pub conversations_file: PathBuf,
}

impl AiPaths {
    pub fn prepare(app: &AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("cannot resolve the application data directory: {error}"))?
            .join("ai");
        let agent = root.join("agent");
        let sessions = root.join("sessions");
        let workspace = root.join("workspace");
        for dir in [&root, &agent, &sessions, &workspace] {
            fs::create_dir_all(dir)
                .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
            restrict(dir, 0o700);
        }
        // The analysis workspace must stay empty: it is Pi's cwd and must not
        // inherit project configuration from the user's filesystem.
        Ok(Self {
            context_file: root.join("context.json"),
            settings_file: root.join("settings.json"),
            conversations_file: root.join("conversations.json"),
            root,
            agent,
            sessions,
            workspace,
        })
    }

    /// Optional user-installed Pi extensions. Pi's automatic discovery is
    /// disabled for the analysis process, so TradePanel enumerates the
    /// extension folders itself instead of hardcoding individual filenames.
    /// Both the app-data folder and Pi's own global folder are considered.
    pub fn extension_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        for dir in [self.root.join("extensions"), self.agent.join("extensions")] {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if name.ends_with(".d.ts") {
                    continue;
                }
                let supported = matches!(
                    path.extension().and_then(|ext| ext.to_str()),
                    Some("ts" | "js" | "mjs" | "cjs")
                );
                if supported {
                    files.push(path);
                }
            }
        }
        files.sort();
        files.dedup();
        files
    }

    /// Remove Pi session files for a deleted conversation. Only files whose
    /// name ends in `_<id>.jsonl` are touched; everything else is left alone.
    pub fn delete_session_files(&self, id: &str) -> usize {
        let suffix = format!("_{id}.jsonl");
        delete_matching(&self.sessions, &suffix)
    }

    /// Read conversation history straight from Pi's session JSONL without
    /// starting the runtime. Returns user/assistant messages only; images are
    /// reduced to an `omitted` marker so the payload stays small.
    pub fn read_session_messages(&self, id: &str, limit: usize) -> Vec<Value> {
        let suffix = format!("_{id}.jsonl");
        let Some(path) = find_session_file(&self.sessions, &suffix) else {
            return Vec::new();
        };
        let Ok(file) = fs::File::open(&path) else {
            return Vec::new();
        };
        let mut messages: Vec<Value> = Vec::new();
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { break };
            if line.len() > 2 * 1024 * 1024 || !line.contains("\"message\"") {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if entry.get("type").and_then(Value::as_str) != Some("message") {
                continue;
            }
            let Some(message) = entry.get("message") else {
                continue;
            };
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if role == "toolResult" {
                let tool = message
                    .get("toolName")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let is_error = message
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if tool == "panel_submit_trade_plan" && !is_error {
                    if let Some(plan) = message
                        .get("details")
                        .and_then(|details| details.get("plan"))
                    {
                        messages.push(json!({
                            "role": "plan",
                            "plan": plan,
                            "timestamp": message.get("timestamp").cloned().unwrap_or(Value::Null),
                        }));
                        if messages.len() > limit {
                            messages.remove(0);
                        }
                    }
                }
                continue;
            }
            if role != "user" && role != "assistant" {
                continue;
            }
            let mut content = message.get("content").cloned().unwrap_or_else(|| json!(""));
            super::context::strip_image_payloads(&mut content);
            if role == "assistant" {
                let has_text = content
                    .as_str()
                    .map(|text| !text.trim().is_empty())
                    .unwrap_or_else(|| {
                        content.as_array().is_some_and(|parts| {
                            parts.iter().any(|part| {
                                part.get("type").and_then(Value::as_str) == Some("text")
                                    && part
                                        .get("text")
                                        .and_then(Value::as_str)
                                        .is_some_and(|text| !text.trim().is_empty())
                            })
                        })
                    });
                if !has_text {
                    continue;
                }
            }
            messages.push(json!({
                "role": role,
                "content": content,
                "timestamp": message.get("timestamp").cloned().unwrap_or(Value::Null),
                "model": message.get("model").cloned().unwrap_or(Value::Null),
                "stopReason": message.get("stopReason").cloned().unwrap_or(Value::Null),
            }));
            if messages.len() > limit {
                messages.remove(0);
            }
        }
        messages
    }
}

fn find_session_file(dir: &Path, suffix: &str) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let candidate = if path.is_dir() {
            find_session_file(&path, suffix)
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(suffix))
        {
            Some(path)
        } else {
            None
        };
        if let Some(candidate) = candidate {
            let modified = fs::metadata(&candidate)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(current, _)| modified > *current) {
                best = Some((modified, candidate));
            }
        }
    }
    best.map(|(_, path)| path)
}

fn delete_matching(dir: &Path, suffix: &str) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            removed += delete_matching(&path, suffix);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(suffix))
        {
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

pub fn restrict(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_cached_history_without_the_runtime_and_strips_images() {
        let base = std::env::temp_dir().join(format!(
            "tradepanel-ai-history-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let sessions = base.join("sessions/--workspace--");
        fs::create_dir_all(&sessions).unwrap();
        let path = sessions.join("2026-01-01_ai-history.jsonl");
        let lines = [
            r#"{"type":"message","message":{"role":"system","content":"prompt","timestamp":1}}"#,
            r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"analyse BTC"},{"type":"image","data":"AAAA","mimeType":"image/png"}],"timestamp":2}}"#,
            r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Long bias."}],"timestamp":3,"model":"openai/gpt"}}"#,
            r#"{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"ignored"}],"timestamp":4}}"#,
            r#"{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"1","name":"x","arguments":{}}],"timestamp":5}}"#,
        ];
        fs::write(&path, lines.join("\n")).unwrap();
        let paths = AiPaths {
            root: base.clone(),
            agent: base.join("agent"),
            sessions: base.join("sessions"),
            workspace: base.join("workspace"),
            context_file: base.join("context.json"),
            settings_file: base.join("settings.json"),
            conversations_file: base.join("conversations.json"),
        };
        let messages = paths.read_session_messages("ai-history", 20);
        assert_eq!(messages.len(), 2, "{messages:?}");
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"][1]["omitted"], true);
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["text"], "Long bias.");
        assert!(paths.read_session_messages("missing", 20).is_empty());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn deletes_only_sessions_for_the_requested_id() {
        let base = std::env::temp_dir().join(format!(
            "tradepanel-ai-sessions-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let dir = base.join("sessions/--workspace--");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("2026-01-01_ai-abc.jsonl"), "{}").unwrap();
        fs::write(dir.join("2026-01-01_ai-abcd.jsonl"), "{}").unwrap();
        fs::write(dir.join("notes.txt"), "keep").unwrap();
        assert_eq!(delete_matching(&base.join("sessions"), "_ai-abc.jsonl"), 1);
        assert!(dir.join("2026-01-01_ai-abcd.jsonl").is_file());
        assert!(dir.join("notes.txt").is_file());
        let _ = fs::remove_dir_all(base);
    }
}

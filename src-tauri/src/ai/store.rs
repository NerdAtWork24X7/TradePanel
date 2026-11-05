//! Durable AI settings and conversation index.
//!
//! Conversations themselves live in Pi session files; this store keeps the
//! user-visible list (id, title, timestamps, model). Writes are atomic so a
//! crash cannot truncate the index.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::paths::restrict;

pub const MAX_TITLE_CHARS: usize = 80;
pub const MAX_CONVERSATIONS: usize = 100;
pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: String,
    pub model: String,
    pub thinking: String,
    pub portfolio_context: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationStore {
    pub version: u32,
    pub active: String,
    pub items: Vec<Conversation>,
}

impl Default for ConversationStore {
    fn default() -> Self {
        Self {
            version: 1,
            active: String::new(),
            items: Vec::new(),
        }
    }
}

pub struct AiStore {
    settings_file: PathBuf,
    conversations_file: PathBuf,
    settings: Mutex<AiSettings>,
    conversations: Mutex<ConversationStore>,
    counter: AtomicU64,
}

impl AiStore {
    pub fn load(settings_file: PathBuf, conversations_file: PathBuf) -> Self {
        let settings = read_json(&settings_file).unwrap_or_default();
        let mut conversations: ConversationStore =
            read_json(&conversations_file).unwrap_or_default();
        conversations.version = 1;
        conversations
            .items
            .retain(|item| is_valid_id(&item.id) && item.title.len() <= MAX_TITLE_CHARS * 4);
        if conversations.items.is_empty() {
            conversations.active.clear();
        } else if !conversations
            .items
            .iter()
            .any(|item| item.id == conversations.active)
        {
            conversations.active = conversations.items[0].id.clone();
        }
        Self {
            settings_file,
            conversations_file,
            settings: Mutex::new(sanitize_settings(settings).unwrap_or_else(|_| AiSettings {
                thinking: "medium".to_string(),
                ..AiSettings::default()
            })),
            conversations: Mutex::new(conversations),
            counter: AtomicU64::new(0),
        }
    }

    pub fn settings(&self) -> AiSettings {
        self.settings.lock().unwrap().clone()
    }

    pub fn save_settings(&self, settings: AiSettings) -> Result<AiSettings, String> {
        let clean = sanitize_settings(settings)?;
        write_json(&self.settings_file, &clean)?;
        *self.settings.lock().unwrap() = clean.clone();
        Ok(clean)
    }

    pub fn conversations(&self) -> ConversationStore {
        self.conversations.lock().unwrap().clone()
    }

    pub fn active(&self) -> Option<Conversation> {
        let store = self.conversations.lock().unwrap();
        store
            .items
            .iter()
            .find(|item| item.id == store.active)
            .cloned()
    }

    pub fn create(&self, title: Option<&str>) -> Result<Conversation, String> {
        let now = now_ms();
        let id = format!("ai-{now}-{}", self.counter.fetch_add(1, Ordering::SeqCst));
        let conversation = Conversation {
            id: id.clone(),
            title: sanitize_title(title.unwrap_or("New analysis")),
            created_at_ms: now,
            updated_at_ms: now,
            model: String::new(),
        };
        {
            let mut store = self.conversations.lock().unwrap();
            let previous = std::mem::replace(&mut store.active, id);
            store.items.insert(0, conversation.clone());
            if store.items.len() > MAX_CONVERSATIONS {
                // Keep the active conversation even when pruning the oldest.
                let active = store.active.clone();
                let mut kept: Vec<Conversation> = Vec::with_capacity(MAX_CONVERSATIONS);
                kept.push(conversation.clone());
                for item in store.items.drain(..) {
                    if item.id == conversation.id {
                        continue;
                    }
                    if kept.len() >= MAX_CONVERSATIONS - 1 {
                        break;
                    }
                    kept.push(item);
                }
                if !kept.iter().any(|item| item.id == active) {
                    kept.push(Conversation {
                        id: active.clone(),
                        title: "Active analysis".to_string(),
                        created_at_ms: now,
                        updated_at_ms: now,
                        model: String::new(),
                    });
                }
                store.items = kept;
            }
            let _ = previous;
        }
        self.persist_conversations()?;
        Ok(conversation)
    }

    pub fn activate(&self, id: &str) -> Result<Conversation, String> {
        let mut store = self.conversations.lock().unwrap();
        let conversation = store
            .items
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or_else(|| "Conversation not found".to_string())?;
        store.active = conversation.id.clone();
        drop(store);
        self.persist_conversations()?;
        Ok(conversation)
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<Conversation, String> {
        let title = sanitize_title(title);
        let mut store = self.conversations.lock().unwrap();
        let conversation = store
            .items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "Conversation not found".to_string())?;
        conversation.title = title;
        conversation.updated_at_ms = now_ms();
        let result = conversation.clone();
        drop(store);
        self.persist_conversations()?;
        Ok(result)
    }

    pub fn touch(&self, id: &str, model: &str, auto_title: Option<&str>) {
        let mut store = self.conversations.lock().unwrap();
        if let Some(item) = store.items.iter_mut().find(|item| item.id == id) {
            item.updated_at_ms = now_ms();
            if !model.is_empty() {
                item.model = model.to_string();
            }
            if let Some(title) = auto_title {
                if item.title == "New analysis" {
                    item.title = sanitize_title(title);
                }
            }
        }
        drop(store);
        let _ = self.persist_conversations();
    }

    pub fn delete(&self, id: &str) -> Result<ConversationStore, String> {
        let mut store = self.conversations.lock().unwrap();
        store.items.retain(|item| item.id != id);
        if store.active == id {
            store.active = store
                .items
                .first()
                .map(|item| item.id.clone())
                .unwrap_or_default();
        }
        let result = store.clone();
        drop(store);
        self.persist_conversations()?;
        Ok(result)
    }

    fn persist_conversations(&self) -> Result<(), String> {
        let store = self.conversations.lock().unwrap().clone();
        write_json(&self.conversations_file, &store)
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub fn sanitize_title(raw: &str) -> String {
    let mut title: String = raw
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_TITLE_CHARS)
        .collect();
    title = title.trim().to_string();
    if title.is_empty() {
        "New analysis".to_string()
    } else {
        title
    }
}

pub fn validate_provider(provider: &str) -> Result<(), String> {
    let ok = !provider.is_empty()
        && provider.len() <= 40
        && provider
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_');
    if ok {
        Ok(())
    } else {
        Err("Invalid provider id".to_string())
    }
}

pub fn validate_model(model: &str) -> Result<(), String> {
    let ok = !model.is_empty()
        && model.len() <= 120
        && model.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '/' | '@')
        });
    if ok {
        Ok(())
    } else {
        Err("Invalid model id".to_string())
    }
}

fn sanitize_settings(mut settings: AiSettings) -> Result<AiSettings, String> {
    settings.provider = settings.provider.trim().to_string();
    settings.model = settings.model.trim().to_string();
    settings.thinking = settings.thinking.trim().to_string();
    if !settings.provider.is_empty() {
        validate_provider(&settings.provider)?;
    }
    if !settings.model.is_empty() {
        validate_model(&settings.model)?;
    }
    if settings.thinking.is_empty() {
        settings.thinking = "medium".to_string();
    }
    if !THINKING_LEVELS.contains(&settings.thinking.as_str()) {
        return Err("Invalid thinking level".to_string());
    }
    Ok(settings)
}

fn is_valid_id(id: &str) -> bool {
    id.len() <= 64
        && id.starts_with("ai-")
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("cannot serialise {}: {error}", path.display()))?;
    let tmp = path.with_extension("json.tmp");
    let write = || -> std::io::Result<()> {
        fs::write(&tmp, &payload)?;
        restrict(&tmp, 0o600);
        fs::rename(&tmp, path)
    };
    if let Err(error) = write() {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot write {}: {error}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> (PathBuf, AiStore) {
        let base = std::env::temp_dir().join(format!(
            "tradepanel-ai-store-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&base).unwrap();
        let store = AiStore::load(base.join("settings.json"), base.join("conversations.json"));
        (base, store)
    }

    #[test]
    fn conversation_lifecycle_survives_reload() {
        let (base, store) = temp_store("lifecycle");
        let first = store.create(Some("BTC 5m analysis")).unwrap();
        let second = store.create(None).unwrap();
        assert_eq!(store.conversations().active, second.id);
        store.rename(&first.id, "Renamed").unwrap();
        store.touch(&first.id, "openai/gpt-4o-mini", Some("ignored"));
        let reloaded = AiStore::load(base.join("settings.json"), base.join("conversations.json"));
        let list = reloaded.conversations();
        assert_eq!(list.items.len(), 2);
        assert_eq!(list.active, second.id);
        assert!(list.items.iter().any(|item| item.title == "Renamed"));
        reloaded.delete(&second.id).unwrap();
        assert_eq!(reloaded.conversations().active, first.id);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn settings_reject_unknown_thinking_and_control_characters() {
        let (base, store) = temp_store("settings");
        let mut settings = store.settings();
        settings.thinking = "extreme".to_string();
        assert!(store.save_settings(settings.clone()).is_err());
        settings.thinking = "medium".to_string();
        settings.provider = "op\nenai".to_string();
        assert!(store.save_settings(settings).is_err());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn titles_are_bounded_and_never_empty() {
        assert_eq!(sanitize_title("  \u{0007} "), "New analysis");
        assert_eq!(
            sanitize_title(&"x".repeat(500)).chars().count(),
            MAX_TITLE_CHARS
        );
    }
}

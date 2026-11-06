//! OS credential storage.
//!
//! Secrets live in the platform credential store (Windows Credential Manager,
//! macOS Keychain, Linux Secret Service via D-Bus). There is no plaintext
//! fallback: if the store is unavailable the command fails explicitly.
//!
//! Only `set` flags, labels and non-secret values ever cross the IPC boundary
//! back into the WebView; secret values are pushed to the Python sidecar
//! environment or via the internal `system.set_credentials` RPC.
//!
//! The credential key catalogue is embedded from `shared/exchanges.json`, the
//! same file the Python sidecar reads, so the two layers cannot drift.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

pub const SERVICE: &str = "TradePanel";

#[derive(Debug, Clone)]
pub struct FieldSpec {
    pub key: String,
    pub label: String,
    pub secret: bool,
    pub group: String,
    pub exchange: String,
    pub kind: String,
    pub multiline: bool,
    pub networks: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CatalogFile {
    exchanges: Vec<CatalogExchange>,
}

#[derive(Debug, Deserialize)]
struct CatalogExchange {
    id: String,
    name: String,
    #[serde(default)]
    networks: Vec<String>,
    fields: Vec<CatalogField>,
}

#[derive(Debug, Deserialize)]
struct CatalogField {
    key: String,
    label: String,
    #[serde(default)]
    secret: bool,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    multiline: bool,
}

fn default_kind() -> String {
    "text".to_string()
}

/// Parsed once at first use. The JSON is embedded at compile time and covered
/// by unit tests, so a malformed file is a build-time defect, not a runtime one.
pub fn fields() -> &'static [FieldSpec] {
    static FIELDS: OnceLock<Vec<FieldSpec>> = OnceLock::new();
    FIELDS.get_or_init(|| {
        let raw = include_str!("../../../shared/exchanges.json");
        let catalog: CatalogFile =
            serde_json::from_str(raw).expect("shared/exchanges.json is malformed");
        let mut out = Vec::new();
        for exchange in catalog.exchanges {
            for field in exchange.fields {
                out.push(FieldSpec {
                    key: field.key,
                    label: field.label,
                    secret: field.secret,
                    group: exchange.name.clone(),
                    exchange: exchange.id.clone(),
                    kind: field.kind,
                    multiline: field.multiline,
                    networks: exchange.networks.clone(),
                });
            }
        }
        out
    })
}

pub fn is_known_key(key: &str) -> bool {
    fields().iter().any(|spec| spec.key == key)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialField {
    pub key: String,
    pub label: String,
    pub secret: bool,
    pub group: String,
    pub exchange: String,
    pub kind: String,
    pub multiline: bool,
    pub set: bool,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSaveResult {
    pub keys: Vec<String>,
    pub fields: Vec<CredentialField>,
}

#[derive(Debug, Default)]
pub struct SecretStore;

impl SecretStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(key: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, key).map_err(store_error)
    }

    /// Secret values for sidecar startup. Missing entries are skipped.
    pub fn load_into_env(&self) -> HashMap<String, String> {
        let mut out = HashMap::new();
        for spec in fields() {
            match self.get(&spec.key) {
                Ok(Some(value)) => {
                    out.insert(spec.key.clone(), value.to_string());
                }
                Ok(None) => {}
                Err(error) => {
                    log::warn!(
                        "Credential store unavailable ({error}); continuing without {}",
                        spec.key
                    )
                }
            }
        }
        out
    }

    /// Read a non-trading secret (used for the AI provider key). The caller is
    /// responsible for the key namespace and validation; trading credentials
    /// keep using the fixed catalogue above.
    pub fn get_external(&self, key: &str) -> Result<Option<Zeroizing<String>>, String> {
        self.get(key)
    }

    /// Store a non-trading secret in the OS credential store.
    #[allow(dead_code)] // retained for migrating older keyring-only installs
    pub fn set_external(&self, key: &str, value: &str) -> Result<(), String> {
        if !key.starts_with("AI_PROVIDER_") || key.len() > 96 {
            return Err("Refusing to store an unknown secret namespace".to_string());
        }
        if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
            return Err("Invalid secret value".to_string());
        }
        let entry = Self::entry(key)?;
        entry.set_password(value).map_err(store_error)
    }

    /// Remove a non-trading secret. A missing entry is not an error.
    pub fn delete_external(&self, key: &str) -> Result<(), String> {
        if !key.starts_with("AI_PROVIDER_") || key.len() > 96 {
            return Err("Refusing to delete an unknown secret namespace".to_string());
        }
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(store_error(error)),
        }
    }

    pub fn get(&self, key: &str) -> Result<Option<Zeroizing<String>>, String> {
        let entry = Self::entry(key)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(store_error(error)),
        }
    }

    pub fn status(&self) -> Result<Vec<CredentialField>, String> {
        let catalogue = fields();
        let mut out = Vec::with_capacity(catalogue.len());
        for spec in catalogue {
            let stored = match Self::entry(&spec.key)?.get_password() {
                Ok(value) => Some(value),
                Err(KeyringError::NoEntry) => None,
                Err(error) => return Err(store_error(error)),
            };
            let set = stored.is_some();
            // Non-secret values (wallet address, network) are rendered in the
            // settings form; secrets never cross the IPC boundary.
            let value = if spec.secret {
                String::new()
            } else {
                stored.unwrap_or_default()
            };
            out.push(CredentialField {
                key: spec.key.clone(),
                label: spec.label.clone(),
                secret: spec.secret,
                group: spec.group.clone(),
                exchange: spec.exchange.clone(),
                kind: spec.kind.clone(),
                multiline: spec.multiline,
                set,
                value,
            });
        }
        Ok(out)
    }

    pub fn save(
        &self,
        values: &HashMap<String, String>,
        clear: &[String],
    ) -> Result<CredentialSaveResult, String> {
        let mut changed = Vec::new();

        for key in clear {
            if !is_known_key(key) {
                return Err(format!("Unknown credential: {key}"));
            }
            let entry = Self::entry(key)?;
            match entry.delete_credential() {
                Ok(()) => changed.push(key.clone()),
                Err(KeyringError::NoEntry) => {}
                Err(error) => return Err(store_error(error)),
            }
        }

        for (key, raw) in values {
            let spec = fields()
                .iter()
                .find(|spec| spec.key == *key)
                .ok_or_else(|| format!("Unknown credential: {key}"))?;
            let value = Zeroizing::new(raw.trim().to_string());
            if value.is_empty() {
                continue;
            }
            validate(&spec.key, &value)?;
            let entry = Self::entry(&spec.key)?;
            entry.set_password(&value).map_err(store_error)?;
            changed.push(spec.key.clone());
        }

        changed.sort();
        changed.dedup();
        let fields = self.status()?;
        log::info!("Credential store updated: {}", changed.join(", "));
        Ok(CredentialSaveResult {
            keys: changed,
            fields,
        })
    }

    /// Copy credentials from a legacy `keys/.env` file into the keyring.
    /// Existing keyring values win. Returns the number of imported keys.
    pub fn import_legacy_env(&self, path: &Path) -> usize {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(_) => return 0,
        };
        let mut imported = 0usize;
        for (key, value) in parse_env(&text) {
            if !is_known_key(&key) || value.trim().is_empty() {
                continue;
            }
            match self.get(&key) {
                Ok(Some(_)) => continue,
                Ok(None) => {}
                Err(error) => {
                    log::warn!("Cannot import legacy credentials: {error}");
                    return imported;
                }
            }
            if validate(&key, &value).is_err() {
                log::warn!("Legacy credential {key} has an invalid value; skipped");
                continue;
            }
            match Self::entry(&key) {
                Ok(entry) => match entry.set_password(&value) {
                    Ok(()) => imported += 1,
                    Err(error) => log::warn!("Cannot import legacy credential {key}: {error}"),
                },
                Err(error) => {
                    log::warn!("Cannot import legacy credentials: {error}");
                    break;
                }
            }
        }
        if imported > 0 {
            log::warn!(
                "Imported {imported} legacy credential(s) from {} into the OS credential store. \
                 Remove the plaintext file once you have verified trading works.",
                path.display()
            );
        }
        imported
    }
}

fn store_error(error: KeyringError) -> String {
    match error {
        KeyringError::NoEntry => "Credential is not set".to_string(),
        other => format!(
            "OS credential store unavailable or locked ({other}). \
             Unlock the system keyring and retry; TradePanel will not store secrets in plaintext."
        ),
    }
}

fn is_hex(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn validate(key: &str, value: &str) -> Result<(), String> {
    let spec = fields()
        .iter()
        .find(|spec| spec.key == key)
        .ok_or_else(|| format!("Unknown credential: {key}"))?;

    if spec.kind == "choice" {
        if !spec.networks.iter().any(|network| network == value) {
            return Err(format!(
                "{} network must be one of: {}",
                spec.group,
                spec.networks.join(", ")
            ));
        }
        return Ok(());
    }
    if key == "HL_PRIVATE_KEY" {
        let digits = value.strip_prefix("0x").unwrap_or(value);
        if digits.len() != 64 || !is_hex(digits) {
            return Err(
                "Hyperliquid private key must be 64 hex characters (optional 0x prefix)"
                    .to_string(),
            );
        }
    }
    if key == "HL_ADDRESS" {
        let digits = value.strip_prefix("0x").unwrap_or("");
        if digits.len() != 40 || !is_hex(digits) {
            return Err("Wallet address must be 0x followed by 40 hex characters".to_string());
        }
    }
    let bad_control = value.chars().any(|ch| {
        let allowed_multiline = spec.multiline && matches!(ch, '\r' | '\n' | '\t');
        ch.is_control() && !allowed_multiline
    });
    if bad_control {
        return Err(format!("{} contains control characters", spec.label));
    }
    if value.trim().is_empty() {
        return Err(format!("{} must not be empty", spec.label));
    }
    let limit = if spec.secret && spec.multiline {
        4096
    } else {
        512
    };
    if value.len() > limit {
        return Err(format!("{} is too long", spec.label));
    }
    if spec.kind == "text" && value.trim().len() < 8 {
        return Err(format!("{} looks too short", spec.label));
    }
    Ok(())
}

fn parse_env(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            continue;
        }
        let mut value = raw.trim().to_string();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = value[1..value.len() - 1].to_string();
        }
        out.push((key.to_string(), value));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_covers_every_chart_exchange() {
        let keys: Vec<&str> = fields().iter().map(|spec| spec.key.as_str()).collect();
        for expected in [
            "HL_PRIVATE_KEY",
            "BINANCE_API_KEY",
            "BYBIT_API_SECRET",
            "OKX_PASSPHRASE",
            "GATE_NETWORK",
            "BITGET_API_KEY",
            "KUCOIN_PASSPHRASE",
            "COINBASE_API_SECRET",
            "KRAKEN_API_KEY",
        ] {
            assert!(keys.contains(&expected), "missing {expected}");
        }
        assert!(fields().iter().all(|spec| !spec.exchange.is_empty()));
        assert!(fields()
            .iter()
            .all(|spec| ["text", "secret", "choice"].contains(&spec.kind.as_str())));
    }

    #[test]
    fn validates_hyperliquid_values() {
        assert!(validate("HL_PRIVATE_KEY", &format!("0x{}", "ab".repeat(32))).is_ok());
        assert!(validate("HL_PRIVATE_KEY", &"ab".repeat(32)).is_ok());
        assert!(validate("HL_PRIVATE_KEY", "short").is_err());
        assert!(validate("HL_PRIVATE_KEY", &"zz".repeat(32)).is_err());
        assert!(validate("HL_ADDRESS", &format!("0x{}", "cd".repeat(20))).is_ok());
        assert!(validate("HL_ADDRESS", "deadbeef").is_err());
        assert!(validate("HL_ADDRESS", &format!("0x{}", "cd".repeat(21))).is_err());
        assert!(validate("HL_PRIVATE_KEY", "ab\ncd").is_err());
        assert!(validate("UNKNOWN", "x").is_err());
    }

    #[test]
    fn validates_network_choices() {
        assert!(validate("BINANCE_NETWORK", "testnet").is_ok());
        assert!(validate("BINANCE_NETWORK", "live").is_ok());
        assert!(validate("BINANCE_NETWORK", "demo").is_err());
        assert!(validate("KUCOIN_NETWORK", "testnet").is_err());
    }

    #[test]
    fn accepts_multiline_coinbase_secret() {
        let pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
        assert!(validate("COINBASE_API_SECRET", pem).is_ok());
        assert!(validate("BINANCE_API_SECRET", "a\nb").is_err());
    }

    #[test]
    fn parses_dotenv_lines_without_leaking_quotes() {
        let parsed = parse_env(
            "# comment\nexport HL_ADDRESS=0xabc\nHL_PRIVATE_KEY=\"deadbeef\"\nINVALID LINE\n",
        );
        assert_eq!(
            parsed,
            vec![
                ("HL_ADDRESS".to_string(), "0xabc".to_string()),
                ("HL_PRIVATE_KEY".to_string(), "deadbeef".to_string()),
            ]
        );
    }
}

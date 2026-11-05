//! OS credential storage.
//!
//! Secrets live in the platform credential store (Windows Credential Manager,
//! macOS Keychain, Linux Secret Service via D-Bus). There is no plaintext
//! fallback: if the store is unavailable the command fails explicitly.
//!
//! Only `set` flags and labels ever cross the IPC boundary back into the
//! WebView; secret values are pushed to the Python sidecar environment or via
//! the internal `system.set_credentials` RPC.

use std::collections::HashMap;
use std::path::Path;

use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
use zeroize::Zeroizing;

pub const SERVICE: &str = "TradePanel";

#[derive(Debug, Clone, Copy)]
pub struct FieldSpec {
    pub key: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub group: &'static str,
}

pub const FIELDS: [FieldSpec; 2] = [
    FieldSpec {
        key: "HL_ADDRESS",
        label: "Wallet address",
        secret: false,
        group: "Hyperliquid",
    },
    FieldSpec {
        key: "HL_PRIVATE_KEY",
        label: "Private key",
        secret: true,
        group: "Hyperliquid",
    },
];


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialField {
    pub key: String,
    pub label: String,
    pub secret: bool,
    pub group: String,
    pub set: bool,
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
        Entry::new(SERVICE, key).map_err(|error| store_error(error))
    }

    /// Secret values for sidecar startup. Missing entries are skipped.
    pub fn load_into_env(&self) -> HashMap<String, String> {
        let mut out = HashMap::new();
        for spec in FIELDS {
            match self.get(spec.key) {
                Ok(Some(value)) => {
                    out.insert(spec.key.to_string(), value.to_string());
                }
                Ok(None) => {}
                Err(error) => {
                    log::warn!("Credential store unavailable ({error}); continuing without {}", spec.key)
                }
            }
        }
        out
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
        let mut fields = Vec::with_capacity(FIELDS.len());
        for spec in FIELDS {
            let set = match Self::entry(spec.key) {
                Ok(entry) => match entry.get_password() {
                    Ok(_) => true,
                    Err(KeyringError::NoEntry) => false,
                    Err(error) => return Err(store_error(error)),
                },
                Err(error) => return Err(error),
            };
            fields.push(CredentialField {
                key: spec.key.to_string(),
                label: spec.label.to_string(),
                secret: spec.secret,
                group: spec.group.to_string(),
                set,
            });
        }
        Ok(fields)
    }

    pub fn save(
        &self,
        values: &HashMap<String, String>,
        clear: &[String],
    ) -> Result<CredentialSaveResult, String> {
        let mut changed = Vec::new();

        for key in clear {
            if !FIELDS.iter().any(|spec| spec.key == key) {
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
            let spec = FIELDS
                .iter()
                .find(|spec| spec.key == key)
                .ok_or_else(|| format!("Unknown credential: {key}"))?;
            let value = Zeroizing::new(raw.trim().to_string());
            if value.is_empty() {
                continue;
            }
            validate(spec.key, &value)?;
            let entry = Self::entry(spec.key)?;
            entry
                .set_password(&value)
                .map_err(|error| store_error(error))?;
            changed.push(spec.key.to_string());
        }

        changed.sort();
        changed.dedup();
        let fields = self.status()?;
        log::info!("Credential store updated: {}", changed.join(", "));
        Ok(CredentialSaveResult { keys: changed, fields })
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
            if !FIELDS.iter().any(|spec| spec.key == key) || value.trim().is_empty() {
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
    if value.chars().any(|ch| ch.is_control()) {
        return Err("Credential contains control characters".to_string());
    }
    match key {
        "HL_PRIVATE_KEY" => {
            let digits = value.strip_prefix("0x").unwrap_or(value);
            if digits.len() != 64 || !is_hex(digits) {
                return Err(
                    "Hyperliquid private key must be 64 hex characters (optional 0x prefix)"
                        .to_string(),
                );
            }
        }
        "HL_ADDRESS" => {
            let digits = value.strip_prefix("0x").unwrap_or("");
            if digits.len() != 40 || !is_hex(digits) {
                return Err("Wallet address must be 0x followed by 40 hex characters".to_string());
            }
        }
        _ => return Err(format!("Unknown credential: {key}")),
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
        if key.is_empty() || !key.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
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

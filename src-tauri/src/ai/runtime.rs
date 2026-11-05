//! Discovery and validation of the bundled Node + Pi runtime.
//!
//! The runtime is a build artifact (`src-tauri/ai-runtime/<target>`). Nothing
//! is downloaded at application start: if the runtime is missing the AI panel
//! reports it and trading continues untouched.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
pub struct AiRuntime {
    pub root: PathBuf,
    pub node: PathBuf,
    pub pi_cli: PathBuf,
    pub extension: PathBuf,
    pub system_prompt: PathBuf,
    /// Provider login/model-catalogue bridge (optional for older runtimes).
    pub settings_service: Option<PathBuf>,
    pub node_version: String,
    pub pi_version: String,
    pub target: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: u32,
    target: String,
    node_version: String,
    pi_version: String,
    node: String,
    pi_cli: String,
    extension: String,
    system_prompt: String,
    #[serde(default)]
    settings_service: Option<String>,
}

/// Host target id used by the runtime manifest (`linux-x64`, `win-x64`, …).
pub fn host_target() -> String {
    let platform = match std::env::consts::OS {
        "windows" => "win",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{platform}-{arch}")
}

impl AiRuntime {
    pub fn discover(app: &AppHandle) -> Result<Self, String> {
        let target = host_target();
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(value) = std::env::var("TRADEPANEL_AI_RUNTIME") {
            let value = value.trim();
            if !value.is_empty() {
                let path = PathBuf::from(value);
                if path.join("manifest.json").is_file() {
                    candidates.push(path);
                } else {
                    candidates.push(path.join(&target));
                }
            }
        }
        if let Ok(resource) = app.path().resource_dir() {
            candidates.push(resource.join("ai-runtime").join(&target));
            candidates.push(resource.join("ai-runtime"));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("ai-runtime").join(&target));
                candidates.push(
                    dir.join("..")
                        .join("Resources")
                        .join("ai-runtime")
                        .join(&target),
                );
                candidates.push(dir.join("ai-runtime"));
            }
        }
        // Development and CI: `cargo run` does not stage bundle resources.
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("ai-runtime")
                .join(&target),
        );
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("ai-runtime"));

        let mut errors = Vec::new();
        for candidate in candidates {
            match Self::from_root(&candidate) {
                Ok(runtime) => return Ok(runtime),
                Err(error) => errors.push(format!("{}: {error}", candidate.display())),
            }
        }
        Err(format!(
            "The bundled AI runtime is missing or incomplete. Build it with \
             `node backend/scripts/build-ai-runtime.mjs`. Tried: {}",
            errors.join(" | ")
        ))
    }

    pub fn from_root(root: &Path) -> Result<Self, String> {
        let manifest_path = root.join("manifest.json");
        let text = std::fs::read_to_string(&manifest_path)
            .map_err(|error| format!("cannot read manifest: {error}"))?;
        let manifest: Manifest =
            serde_json::from_str(&text).map_err(|error| format!("invalid manifest: {error}"))?;
        if manifest.schema != 1 {
            return Err(format!("unsupported manifest schema {}", manifest.schema));
        }
        let node = resolve_inside(root, &manifest.node)?;
        let pi_cli = resolve_inside(root, &manifest.pi_cli)?;
        let extension = resolve_inside(root, &manifest.extension)?;
        let system_prompt = resolve_inside(root, &manifest.system_prompt)?;
        let settings_service = match manifest.settings_service.as_deref() {
            Some(relative) => Some(resolve_inside(root, relative)?),
            None => {
                // Older staged runtimes predate the auth bridge. Keep the
                // analysis runtime usable; auth commands report it as missing.
                let fallback = root.join("pi/settings-service.mjs");
                fallback.is_file().then_some(fallback)
            }
        };
        for (label, path) in [
            ("node", &node),
            ("pi cli", &pi_cli),
            ("extension", &extension),
            ("system prompt", &system_prompt),
        ] {
            if !path.is_file() {
                return Err(format!("{label} is missing: {}", path.display()));
            }
        }
        ensure_executable(&node);
        if let Some(service) = settings_service.as_ref() {
            if !service.is_file() {
                return Err(format!(
                    "settings service is missing: {}",
                    service.display()
                ));
            }
        }
        Ok(Self {
            root: root.to_path_buf(),
            node,
            pi_cli,
            extension,
            system_prompt,
            settings_service,
            node_version: manifest.node_version,
            pi_version: manifest.pi_version,
            target: manifest.target,
        })
    }
}

/// Resolve a manifest-relative path and refuse anything that escapes the
/// runtime root (a tampered manifest must not point at arbitrary files).
fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() || Path::new(relative).is_absolute() {
        return Err(format!("manifest path must be relative: {relative:?}"));
    }
    let joined = root.join(relative);
    let normalized = normalize(&joined);
    let root_normalized = normalize(root);
    if !normalized.starts_with(&root_normalized) {
        return Err(format!("manifest path escapes the runtime: {relative:?}"));
    }
    Ok(normalized)
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn ensure_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mode = meta.permissions().mode();
            if mode & 0o111 == 0 {
                let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_fixture(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "tradepanel-ai-runtime-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("runtime");
        std::fs::create_dir_all(root.join("node")).unwrap();
        for (path, body) in [
            ("node/node", "#!/bin/sh\n"),
            ("pi/cli.js", "// cli\n"),
            ("pi/extensions/a.mjs", "// ext\n"),
            ("pi/prompts/a.md", "# prompt\n"),
            ("pi/settings-service.mjs", "// settings\n"),
        ] {
            let target = root.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, body).unwrap();
        }
        (base, root)
    }

    #[test]
    fn accepts_a_valid_manifest() {
        let (base, root) = runtime_fixture("valid");
        std::fs::write(
            root.join("manifest.json"),
            r#"{"schema":1,"target":"linux-x64","nodeVersion":"v22.0.0","piVersion":"1.5.0","node":"node/node","piCli":"pi/cli.js","extension":"pi/extensions/a.mjs","systemPrompt":"pi/prompts/a.md","settingsService":"pi/settings-service.mjs"}"#,
        )
        .unwrap();
        let runtime = AiRuntime::from_root(&root).expect("valid runtime");
        assert_eq!(runtime.pi_version, "1.5.0");
        assert!(runtime.settings_service.is_some());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn old_manifest_without_settings_service_still_loads() {
        let (base, root) = runtime_fixture("legacy");
        std::fs::remove_file(root.join("pi/settings-service.mjs")).unwrap();
        std::fs::write(
            root.join("manifest.json"),
            r#"{"schema":1,"target":"linux-x64","nodeVersion":"v22.0.0","piVersion":"1.5.0","node":"node/node","piCli":"pi/cli.js","extension":"pi/extensions/a.mjs","systemPrompt":"pi/prompts/a.md"}"#,
        )
        .unwrap();
        let runtime = AiRuntime::from_root(&root).expect("legacy runtime");
        assert!(runtime.settings_service.is_none());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_path_traversal_and_absolute_paths() {
        let (base, root) = runtime_fixture("escape");
        for (label, node) in [("parent", "../../etc/passwd"), ("absolute", "/etc/passwd")] {
            std::fs::write(
                root.join("manifest.json"),
                format!(
                    r#"{{"schema":1,"target":"linux-x64","nodeVersion":"v22.0.0","piVersion":"1.5.0","node":"{node}","piCli":"pi/cli.js","extension":"pi/extensions/a.mjs","systemPrompt":"pi/prompts/a.md"}}"#
                ),
            )
            .unwrap();
            let error = AiRuntime::from_root(&root).expect_err(label);
            assert!(
                error.contains("escapes") || error.contains("relative"),
                "{error}"
            );
        }
        let _ = std::fs::remove_dir_all(base);
    }
}

//! Discovery and validation of the bundled Node + Pi runtime.
//!
//! The runtime is a build artifact (`src-tauri/ai-runtime/<target>`). Nothing
//! is downloaded at application start: if the runtime is missing the AI panel
//! reports it and trading continues untouched.
//!
//! Users can update the Pi package in place (Settings → Updates). Those updates
//! live in a writable overlay under the app-data directory, because the bundle
//! itself is read-only when TradePanel is installed system-wide. An overlay
//! only wins over the bundle when its Pi version is strictly newer, so an
//! application update always supersedes a stale overlay.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

/// The Pi npm package the runtime is built around.
pub const PI_PACKAGE: &str = "@earendil-works/pi-coding-agent";
/// Pi's bundled CLI, relative to the `pi` directory inside a runtime.
pub const PI_CLI_RELATIVE: &str = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
/// npm CLI staged inside the runtime (`<root>/npm/bin/npm-cli.js`).
pub const NPM_CLI_RELATIVE: &str = "bin/npm-cli.js";

#[derive(Debug, Clone)]
pub struct AiRuntime {
    /// Directory whose `pi` tree is active (the bundle or an update overlay).
    pub root: PathBuf,
    /// Directory of the bundled runtime shipped with the application.
    pub base_root: PathBuf,
    pub node: PathBuf,
    pub pi_cli: PathBuf,
    pub extension: PathBuf,
    pub system_prompt: PathBuf,
    /// Provider login/model-catalogue bridge (optional for older runtimes).
    pub settings_service: Option<PathBuf>,
    /// Staged npm CLI used for in-app runtime updates (schema 2 runtimes).
    pub npm_cli: Option<PathBuf>,
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
    #[serde(default)]
    npm: Option<String>,
}

/// Manifest written by an in-app Pi update (`<app-data>/ai/runtime/<target>`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayManifest {
    schema: u32,
    target: String,
    pi_version: String,
    pi: String,
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
        let base = Self::discover_base(app)?;
        Ok(Self::with_overlay(app, base))
    }

    /// Prefer a user-installed Pi update over the bundle when it is newer.
    fn with_overlay(app: &AppHandle, base: Self) -> Self {
        let Ok(data) = app.path().app_data_dir() else {
            return base;
        };
        let root = data.join("ai").join("runtime").join(&base.target);
        if !root.join("manifest.json").is_file() {
            return base;
        }
        match Self::from_overlay(&root, &base) {
            Ok(overlay) => {
                log::info!(
                    "Using updated AI runtime: Pi {} ({})",
                    overlay.pi_version,
                    root.display()
                );
                overlay
            }
            Err(error) => {
                log::warn!("Ignoring AI runtime update in {}: {error}", root.display());
                base
            }
        }
    }

    fn discover_base(app: &AppHandle) -> Result<Self, String> {
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
        if !matches!(manifest.schema, 1 | 2) {
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
        let npm_cli = match manifest.npm.as_deref() {
            Some(relative) => {
                let cli = resolve_inside(root, &format!("{relative}/{NPM_CLI_RELATIVE}"))?;
                if !cli.is_file() {
                    return Err(format!("npm cli is missing: {}", cli.display()));
                }
                Some(cli)
            }
            None => None,
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
            base_root: root.to_path_buf(),
            node,
            pi_cli,
            extension,
            system_prompt,
            settings_service,
            npm_cli,
            node_version: manifest.node_version,
            pi_version: manifest.pi_version,
            target: manifest.target,
        })
    }

    /// Build the active runtime from an in-app update overlay. The Node binary
    /// and npm still come from the read-only bundle.
    fn from_overlay(root: &Path, base: &Self) -> Result<Self, String> {
        let text = std::fs::read_to_string(root.join("manifest.json"))
            .map_err(|error| format!("cannot read update manifest: {error}"))?;
        let manifest: OverlayManifest = serde_json::from_str(&text)
            .map_err(|error| format!("invalid update manifest: {error}"))?;
        if manifest.schema != 2 {
            return Err(format!(
                "unsupported update manifest schema {}",
                manifest.schema
            ));
        }
        if manifest.target != base.target {
            return Err(format!(
                "update target {} does not match the bundle ({})",
                manifest.target, base.target
            ));
        }
        if compare_versions(&manifest.pi_version, &base.pi_version) != Ordering::Greater {
            return Err(format!(
                "update Pi {} is not newer than the bundled {}",
                manifest.pi_version, base.pi_version
            ));
        }
        let pi_root = resolve_inside(root, &manifest.pi)?;
        if !pi_root.is_dir() {
            return Err(format!(
                "update Pi directory is missing: {}",
                pi_root.display()
            ));
        }
        let pi_cli = resolve_inside(root, &manifest.pi_cli)?;
        let extension = resolve_inside(root, &manifest.extension)?;
        let system_prompt = resolve_inside(root, &manifest.system_prompt)?;
        let settings_service = match manifest.settings_service.as_deref() {
            Some(relative) => Some(resolve_inside(root, relative)?),
            None => None,
        };
        for (label, path) in [
            ("pi cli", &pi_cli),
            ("extension", &extension),
            ("system prompt", &system_prompt),
        ] {
            if !path.is_file() {
                return Err(format!("{label} is missing: {}", path.display()));
            }
        }
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
            base_root: base.base_root.clone(),
            node: base.node.clone(),
            pi_cli,
            extension,
            system_prompt,
            settings_service,
            npm_cli: base.npm_cli.clone(),
            node_version: base.node_version.clone(),
            pi_version: manifest.pi_version,
            target: base.target.clone(),
        })
    }

    /// True when the active Pi tree comes from an in-app update.
    pub fn is_overlay(&self) -> bool {
        self.root != self.base_root
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

/// Compare dotted versions (`1.10.0` > `1.9.9`, `v22.3.0` == `22.3.0`).
/// A pre-release sorts below its release (`1.6.0-beta` < `1.6.0`). Build
/// metadata (`+sha`) is ignored. Non-numeric segments count as zero, which is
/// enough for npm release versions and Node's `vX.Y.Z`.
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    let (left_core, left_pre) = split_version(left);
    let (right_core, right_pre) = split_version(right);
    let mut left_parts = left_core.split('.');
    let mut right_parts = right_core.split('.');
    loop {
        let left_part = left_parts.next();
        let right_part = right_parts.next();
        if left_part.is_none() && right_part.is_none() {
            break;
        }
        let left_num = left_part.and_then(|part| part.parse::<u64>().ok());
        let right_num = right_part.and_then(|part| part.parse::<u64>().ok());
        match left_num.unwrap_or(0).cmp(&right_num.unwrap_or(0)) {
            Ordering::Equal => {}
            other => return other,
        }
    }
    match (left_pre, right_pre) {
        (None, None) => Ordering::Equal,
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (Some(left_pre), Some(right_pre)) => compare_prerelease(left_pre, right_pre),
    }
}

fn split_version(value: &str) -> (&str, Option<&str>) {
    let value = value.trim().trim_start_matches('v');
    let core_end = value.find(['-', '+']).unwrap_or(value.len());
    let core = &value[..core_end];
    let prerelease = value
        .find('-')
        .map(|index| value[index + 1..].split('+').next().unwrap_or_default());
    (core, prerelease)
}

fn compare_prerelease(left: &str, right: &str) -> Ordering {
    let mut left_parts = left.split('.');
    let mut right_parts = right.split('.');
    loop {
        match (left_parts.next(), right_parts.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(left_part), Some(right_part)) => {
                let ordering = match (left_part.parse::<u64>(), right_part.parse::<u64>()) {
                    (Ok(left_num), Ok(right_num)) => left_num.cmp(&right_num),
                    // Numeric identifiers always sort below alphanumeric ones.
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => left_part.cmp(right_part),
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
        }
    }
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
            ("npm/bin/npm-cli.js", "// npm\n"),
        ] {
            let target = root.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, body).unwrap();
        }
        (base, root)
    }

    fn write_overlay(name: &str, pi_version: &str, target: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "tradepanel-ai-overlay-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let root = base.join("overlay");
        for (path, body) in [
            (
                "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
                "// cli\n",
            ),
            ("pi/extensions/a.mjs", "// ext\n"),
            ("pi/prompts/a.md", "# prompt\n"),
            ("pi/settings-service.mjs", "// settings\n"),
        ] {
            let target = root.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, body).unwrap();
        }
        std::fs::write(
            root.join("manifest.json"),
            format!(
                r#"{{"schema":2,"kind":"overlay","target":"{target}","piVersion":"{pi_version}","pi":"pi","piCli":"pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js","extension":"pi/extensions/a.mjs","systemPrompt":"pi/prompts/a.md","settingsService":"pi/settings-service.mjs"}}"#
            ),
        )
        .unwrap();
        (base, root)
    }

    #[test]
    fn accepts_a_valid_manifest() {
        let (base, root) = runtime_fixture("valid");
        std::fs::write(
            root.join("manifest.json"),
            r#"{"schema":2,"target":"linux-x64","nodeVersion":"v22.0.0","piVersion":"1.5.0","node":"node/node","piCli":"pi/cli.js","extension":"pi/extensions/a.mjs","systemPrompt":"pi/prompts/a.md","settingsService":"pi/settings-service.mjs","npm":"npm"}"#,
        )
        .unwrap();
        let runtime = AiRuntime::from_root(&root).expect("valid runtime");
        assert_eq!(runtime.pi_version, "1.5.0");
        assert!(runtime.settings_service.is_some());
        assert!(runtime.npm_cli.is_some());
        assert_eq!(runtime.root, runtime.base_root);
        assert!(!runtime.is_overlay());
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
        assert!(runtime.npm_cli.is_none());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn rejects_a_missing_npm_tree() {
        let (base, root) = runtime_fixture("no-npm");
        std::fs::remove_file(root.join("npm/bin/npm-cli.js")).unwrap();
        std::fs::write(
            root.join("manifest.json"),
            r#"{"schema":2,"target":"linux-x64","nodeVersion":"v22.0.0","piVersion":"1.5.0","node":"node/node","piCli":"pi/cli.js","extension":"pi/extensions/a.mjs","systemPrompt":"pi/prompts/a.md","npm":"npm"}"#,
        )
        .unwrap();
        let error = AiRuntime::from_root(&root).expect_err("missing npm");
        assert!(error.contains("npm cli is missing"), "{error}");
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

    #[test]
    fn overlay_is_used_only_when_its_pi_is_newer() {
        let (base_dir, root) = runtime_fixture("overlay-base");
        std::fs::write(
            root.join("manifest.json"),
            r#"{"schema":2,"target":"linux-x64","nodeVersion":"v22.0.0","piVersion":"1.5.0","node":"node/node","piCli":"pi/cli.js","extension":"pi/extensions/a.mjs","systemPrompt":"pi/prompts/a.md","settingsService":"pi/settings-service.mjs","npm":"npm"}"#,
        )
        .unwrap();
        let base = AiRuntime::from_root(&root).expect("base runtime");

        let (overlay_dir, overlay_root) = write_overlay("newer", "1.6.0", "linux-x64");
        let overlay = AiRuntime::from_overlay(&overlay_root, &base).expect("overlay");
        assert_eq!(overlay.pi_version, "1.6.0");
        assert!(overlay.is_overlay());
        assert_eq!(overlay.node, base.node);
        assert_eq!(overlay.node_version, base.node_version);
        assert_eq!(overlay.base_root, base.base_root);
        assert_eq!(overlay.npm_cli, base.npm_cli);
        assert!(overlay.pi_cli.ends_with("dist/bundle/cli.js"));

        let (stale_dir, stale_root) = write_overlay("stale", "1.5.0", "linux-x64");
        assert!(AiRuntime::from_overlay(&stale_root, &base).is_err());

        let (wrong_dir, wrong_root) = write_overlay("wrong-target", "1.7.0", "win-x64");
        assert!(AiRuntime::from_overlay(&wrong_root, &base).is_err());

        for dir in [base_dir, overlay_dir, stale_dir, wrong_dir] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn compares_dotted_versions() {
        assert_eq!(compare_versions("1.5.0", "1.5.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("v22.23.4", "22.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("1.6.0-beta.1", "1.6.0"), Ordering::Less);
        assert_eq!(compare_versions("2.0.0-alpha", "1.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.6.0+build.7", "1.6.0"), Ordering::Equal);
    }
}

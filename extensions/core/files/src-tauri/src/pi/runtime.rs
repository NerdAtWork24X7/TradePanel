//! Locating and validating the staged Pi runtime for this host.
//!
//! A runtime directory is produced by `npm run ai:runtime`:
//!
//! ```text
//! <root>/<target>/manifest.json
//! <root>/<target>/node/node(.exe)
//! <root>/<target>/pi/node_modules/@earendil-works/pi-coding-agent/...
//! <root>/<target>/pi/extensions/tradepanel-analysis.mjs
//! <root>/<target>/pi/prompts/analysis.md
//! ```
//!
//! The bundle lives in the Tauri resource directory. A user-writable overlay
//! (`<app-data>/ai/runtime/<target>`) with the same manifest shape wins when
//! present, so an in-app update can replace the runtime without touching an
//! installed (read-only) bundle.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The host's runtime target id, as `scripts/build-ai-runtime.mjs` names it.
pub fn target_id() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "win-x64",
        ("windows", "aarch64") => "win-arm64",
        _ => return None,
    })
}

#[derive(Clone, Debug)]
pub struct PiRuntime {
    pub target: String,
    /// `<root>/<target>` (the manifest's paths are relative to it).
    pub root: PathBuf,
    pub node: PathBuf,
    pub pi_cli: PathBuf,
    /// npm CLI bundled with the runtime (needed by the in-app updater).
    pub npm_cli: Option<PathBuf>,
    pub extension: PathBuf,
    pub system_prompt: PathBuf,
    pub node_version: Option<String>,
    pub pi_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: u32,
    target: String,
    node: String,
    pi_cli: String,
    #[serde(default)]
    npm_cli: Option<String>,
    extension: String,
    system_prompt: String,
    #[serde(default)]
    node_version: Option<String>,
    #[serde(default)]
    pi_version: Option<String>,
}

impl Manifest {
    /// Resolve and check every file the host will run or read. A partial stage
    /// (an interrupted build) must not start Pi with a stale child.
    fn into_runtime(self, root: PathBuf, expected: &str) -> Result<PiRuntime, String> {
        if self.schema != 1 {
            return Err(format!("The AI runtime manifest has schema {} (expected 1).", self.schema));
        }
        if self.target != expected {
            return Err(format!("The AI runtime is for {}, not {expected}.", self.target));
        }
        let file = |relative: &str, label: &str| -> Result<PathBuf, String> {
            let path = root.join(relative);
            if path.is_file() {
                Ok(path)
            } else {
                Err(format!("The AI runtime is incomplete: {label} is missing ({})", path.display()))
            }
        };
        let node = file(&self.node, "the Node executable")?;
        let pi_cli = file(&self.pi_cli, "the Pi CLI")?;
        let npm_cli = self.npm_cli.as_deref().map(|relative| file(relative, "the npm CLI")).transpose()?;
        let extension = file(&self.extension, "the analysis extension")?;
        let system_prompt = file(&self.system_prompt, "the analysis prompt")?;
        Ok(PiRuntime {
            target: self.target,
            root,
            node,
            pi_cli,
            npm_cli,
            extension,
            system_prompt,
            node_version: self.node_version,
            pi_version: self.pi_version,
        })
    }
}

/// Read a staged manifest from a specific root (used to verify an update
/// before it is moved into the overlay).
pub fn validate_at(root: &Path, expected: &str) -> Result<PiRuntime, String> {
    let manifest_path = root.join("manifest.json");
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Cannot read {}: {e}", manifest_path.display()))?;
    let manifest: Manifest = serde_json::from_str(&text)
        .map_err(|e| format!("Cannot parse {}: {e}", manifest_path.display()))?;
    manifest.into_runtime(root.to_path_buf(), expected)
}

/// Resolve only the runtime shipped with the app, never a user overlay. The
/// updater needs its pristine Node/npm/extension files even when an older
/// overlay is in use.
pub fn bundled(app: &AppHandle) -> Result<PiRuntime, String> {
    let target = target_id().ok_or_else(|| {
        format!(
            "This platform ({}-{}) has no bundled AI runtime. Build one with `npm run ai:runtime -- --target <id>`.",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.join("ai-runtime"));
    }
    // `tauri dev` starts the binary from `src-tauri/target/debug`, where the
    // resource directory may not have been staged yet: the source tree is the
    // same checkout the build script writes to.
    #[cfg(debug_assertions)]
    roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("ai-runtime"));
    resolve_in(roots, target)
}

pub fn resolve(app: &AppHandle) -> Result<PiRuntime, String> {
    let target = target_id().ok_or_else(|| {
        format!(
            "This platform ({}-{}) has no bundled AI runtime. Build one with `npm run ai:runtime -- --target <id>`.",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        roots.push(dir.join("ai").join("runtime"));
    }
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir.join("ai-runtime"));
    }
    #[cfg(debug_assertions)]
    roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("ai-runtime"));
    resolve_in(roots, target)
}

fn resolve_in(roots: Vec<PathBuf>, target: &str) -> Result<PiRuntime, String> {
    for root in roots {
        let dir = root.join(target);
        if dir.join("manifest.json").is_file() {
            return validate_at(&dir, target);
        }
    }
    Err(format!(
        "The AI runtime for {target} is not staged. Run `npm run ai:runtime` in opentrader/ and restart the app."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_manifest_resolves_relative_paths() {
        let dir = std::env::temp_dir().join(format!("opentrader-runtime-test-{}", std::process::id()));
        let root = dir.join("linux-x64");
        std::fs::create_dir_all(root.join("node")).unwrap();
        std::fs::create_dir_all(root.join("pi/extensions")).unwrap();
        std::fs::create_dir_all(root.join("pi/prompts")).unwrap();
        std::fs::create_dir_all(root.join("pi/node_modules/pi/dist")).unwrap();
        for (path, bytes) in [
            ("node/node", "node"),
            ("pi/node_modules/pi/dist/cli.js", "cli"),
            ("pi/extensions/tradepanel-analysis.mjs", "extension"),
            ("pi/prompts/analysis.md", "prompt"),
        ] {
            std::fs::write(root.join(path), bytes).unwrap();
        }
        let manifest = Manifest {
            schema: 1,
            target: "linux-x64".into(),
            node: "node/node".into(),
            pi_cli: "pi/node_modules/pi/dist/cli.js".into(),
            npm_cli: None,
            extension: "pi/extensions/tradepanel-analysis.mjs".into(),
            system_prompt: "pi/prompts/analysis.md".into(),
            node_version: Some("v22.23.4".into()),
            pi_version: Some("1.5.0".into()),
        };
        let runtime = manifest.into_runtime(root.clone(), "linux-x64").unwrap();
        assert_eq!(runtime.node, root.join("node/node"));
        assert!(runtime.pi_cli.ends_with("cli.js"));
        assert_eq!(runtime.pi_version.as_deref(), Some("1.5.0"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_or_wrong_target_is_an_actionable_error() {
        let root = std::env::temp_dir().join(format!("opentrader-runtime-missing-{}", std::process::id()));
        let manifest = || Manifest {
            schema: 1,
            target: "linux-x64".into(),
            node: "node/node".into(),
            pi_cli: "pi/cli.js".into(),
            npm_cli: None,
            extension: "pi/ext.mjs".into(),
            system_prompt: "pi/prompt.md".into(),
            node_version: None,
            pi_version: None,
        };
        let err = manifest().into_runtime(root.clone(), "linux-x64").unwrap_err();
        assert!(err.contains("Node executable"), "{err}");
        let err = manifest().into_runtime(root.clone(), "linux-arm64").unwrap_err();
        assert!(err.contains("linux-arm64"), "{err}");
    }
}

//! In-app updates of the Pi coding agent used by Analyze chart.
//!
//! The runtime bundled with the app is read-only, so an update is installed in
//! the user overlay (`<app-data>/ai/runtime/<target>`) that `runtime::resolve`
//! already prefers. The release's own `package.json` and `package-lock.json`
//! come from Pi's installer API; npm runs with scripts and user configuration
//! disabled. A complete stage is verified before it replaces the old overlay,
//! and a failed swap puts the old one back.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::Utc;
use opentrader_core::files;
use opentrader_core::net::{proxy_url, SharedClient};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

use super::manager::PiManager;
use super::{paths::PiPaths, runtime, spawn};

const LATEST_URL: &str = "https://pi.dev/api/latest-version";
const INSTALLER_BASE: &str = "https://pi.dev/api/installer/releases";
const PI_PACKAGE: &str = "@earendil-works/pi-coding-agent";
const PI_CLI: &str = "dist/bundle/cli.js";
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const NPM_TIMEOUT: Duration = Duration::from_secs(600);

static CLIENT: SharedClient = SharedClient::new(|b| {
    b.connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .user_agent("TradePanel AI runtime updater")
});
static UPDATING: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestRelease {
    ok: bool,
    version: String,
    package_name: Option<String>,
}

/// Release files needed to install one pinned Pi version.
struct Release {
    package: String,
    lock: String,
}

/// Serializes updates: a second button press must not replace a half-written stage.
struct SingleUpdate;

impl SingleUpdate {
    fn acquire() -> Result<Self, String> {
        UPDATING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "The Pi update is already running.".to_string())
    }
}

impl Drop for SingleUpdate {
    fn drop(&mut self) {
        UPDATING.store(false, Ordering::Release);
    }
}

/// Removes a staging directory unless the process is stopped between two
/// filesystem calls; the next start ignores it (only `<target>` is resolved).
struct StageGuard(PathBuf);

impl Drop for StageGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub async fn run(app: &AppHandle, manager: &PiManager, on_event: Channel<String>) -> Result<(), String> {
    let _single = SingleUpdate::acquire()?;
    // A broken overlay must not stop a repair: read its version when possible,
    // but always stage new files from the pristine bundled runtime.
    let current_version = runtime::resolve(app).ok().and_then(|rt| rt.pi_version);
    let source = runtime::bundled(app)?;
    let latest = fetch_latest().await?;

    let message = match (&current_version, version_order(&latest, current_version.as_deref().unwrap_or(""))) {
        (Some(version), std::cmp::Ordering::Greater) => {
            format!("Pi {latest} is available (installed: {version}).")
        }
        (Some(version), std::cmp::Ordering::Equal) => {
            let _ = on_event.send(format!("Pi {version} is up to date."));
            return Ok(());
        }
        (Some(version), std::cmp::Ordering::Less) => {
            let _ = on_event.send(format!("Pi {version} is newer than the published {latest}; nothing to do."));
            return Ok(());
        }
        (None, _) => format!("Installing Pi {latest}."),
    };
    let _ = on_event.send(message);

    let npm_cli = source.npm_cli.clone().ok_or_else(|| {
        "This Pi runtime was built without npm support. Rebuild it with `npm run ai:runtime` and try again.".to_string()
    })?;
    let release = fetch_release(&latest).await?;
    let paths = PiPaths::for_app(app)?;
    let runtime_root = paths.root.join("runtime");
    let target = runtime::target_id().ok_or_else(|| "This platform has no Pi runtime target.".to_string())?;
    clean_stale_updates(&runtime_root, target);
    let stage = runtime_root.join(format!(".update-{target}-{}", Utc::now().timestamp_millis()));
    let _stage = StageGuard(stage.clone());

    let _ = on_event.send("Preparing the update…".to_string());
    prepare_stage(&stage, &source, &npm_cli, &release).await?;
    npm_ci(&source.node, &stage.join("npm/bin/npm-cli.js"), &stage.join("pi"), &paths).await?;

    let _ = on_event.send("Verifying the update…".to_string());
    let (node_version, pi_cli) = verify_stage(&stage, &paths, &latest).await?;
    write_manifest(&stage, target, &node_version, &pi_cli, &latest)?;
    let staged = runtime::validate_at(&stage, target)?;

    // Windows cannot rename files held open by a child; stop Pi before the swap.
    manager.prepare_update().await;
    let _ = on_event.send("Switching to the new runtime…".to_string());
    install_overlay(&runtime_root, target, &stage)?;
    manager.clear_runtime_error();
    let _ = on_event.send(format!("Pi {latest} is ready."));
    // The guard only sees the old stage path, which the rename has moved away.
    let _ = &staged;
    Ok(())
}

async fn fetch_latest() -> Result<String, String> {
    let response = CLIENT
        .get()
        .get(LATEST_URL)
        .send()
        .await
        .map_err(|e| format!("Could not check for a Pi update: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The Pi release service answered {}.", response.status()));
    }
    let release: LatestRelease = response.json().await.map_err(|e| format!("Invalid Pi release answer: {e}"))?;
    if !release.ok {
        return Err("The Pi release service reported an unavailable update.".to_string());
    }
    if release.package_name.as_deref().is_some_and(|name| name != PI_PACKAGE) {
        return Err(format!("Unexpected Pi package: {}", release.package_name.unwrap_or_default()));
    }
    if !valid_version(&release.version) {
        return Err(format!("Invalid Pi version: {}", release.version));
    }
    Ok(release.version)
}

async fn fetch_release(version: &str) -> Result<Release, String> {
    let base = format!("{INSTALLER_BASE}/{version}");
    let package_url = format!("{base}/package.json");
    let lock_url = format!("{base}/package-lock.json");
    let (package, lock) = tokio::join!(fetch_text(&package_url), fetch_text(&lock_url));
    let package = package?;
    let lock = lock?;
    validate_release(version, &package, &lock)?;
    Ok(Release { package, lock })
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let response = CLIENT.get().get(url).send().await.map_err(|e| format!("Download failed ({url}): {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Download failed ({url}): {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| format!("Could not read {url}: {e}"))?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err(format!("The release file is unexpectedly large: {url}"));
    }
    String::from_utf8(bytes.to_vec()).map_err(|e| format!("The release file is not UTF-8 ({url}): {e}"))
}

fn validate_release(version: &str, package: &str, lock: &str) -> Result<(), String> {
    let package: Value = serde_json::from_str(package).map_err(|e| format!("Invalid release package.json: {e}"))?;
    let lock: Value = serde_json::from_str(lock).map_err(|e| format!("Invalid release package-lock.json: {e}"))?;
    if package.get("version").and_then(Value::as_str) != Some(version)
        || package.get("dependencies").and_then(|d| d.get(PI_PACKAGE)).and_then(Value::as_str) != Some(version)
    {
        return Err(format!("The release files do not pin Pi {version}."));
    }
    if lock.get("lockfileVersion").and_then(Value::as_u64) != Some(3)
        || lock
            .get("packages")
            .and_then(|p| p.get(""))
            .and_then(|p| p.get("dependencies"))
            .and_then(|d| d.get(PI_PACKAGE))
            .and_then(Value::as_str)
            != Some(version)
        || lock
            .get("packages")
            .and_then(|p| p.get(format!("node_modules/{PI_PACKAGE}")))
            .and_then(|p| p.get("version"))
            .and_then(Value::as_str)
            != Some(version)
    {
        return Err(format!("The release lockfile does not pin Pi {version}."));
    }
    Ok(())
}

async fn prepare_stage(stage: &Path, current: &runtime::PiRuntime, npm_cli: &Path, release: &Release) -> Result<(), String> {
    let pi = stage.join("pi");
    std::fs::create_dir_all(stage.join("node"))
        .and_then(|_| std::fs::create_dir_all(pi.join("extensions")))
        .and_then(|_| std::fs::create_dir_all(pi.join("prompts")))
        .map_err(|e| format!("Cannot create the update stage: {e}"))?;
    files::write_atomic(&pi.join("package.json"), release.package.as_bytes())
        .map_err(|e| format!("Cannot stage package.json: {e}"))?;
    files::write_atomic(&pi.join("package-lock.json"), release.lock.as_bytes())
        .map_err(|e| format!("Cannot stage package-lock.json: {e}"))?;
    copy_file(&current.node, &stage.join("node").join(current.node.file_name().unwrap_or_default()))?;
    copy_file(&current.extension, &pi.join("extensions").join("tradepanel-analysis.mjs"))?;
    copy_file(&current.system_prompt, &pi.join("prompts").join("analysis.md"))?;
    // npm root (the parent of its bin folder) includes the CLI dependencies.
    let npm_root = npm_cli.parent().and_then(Path::parent).ok_or_else(|| "The staged npm path is invalid.".to_string())?;
    copy_tree(npm_root, &stage.join("npm"))?;
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("Cannot create {}: {e}", to.display()))?;
    for entry in std::fs::read_dir(from).map_err(|e| format!("Cannot read {}: {e}", from.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let destination = to.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else {
            copy_file(&entry.path(), &destination)?;
        }
    }
    Ok(())
}

fn copy_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    std::fs::copy(from, to).map_err(|e| format!("Cannot copy {}: {e}", from.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(from).map_err(|e| e.to_string())?.permissions().mode();
        std::fs::set_permissions(to, std::fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn npm_ci(node: &Path, npm_cli: &Path, dir: &Path, paths: &PiPaths) -> Result<(), String> {
    std::fs::create_dir_all(&paths.root).map_err(|e| format!("Cannot create the AI data folder: {e}"))?;
    let cache = paths.root.join("npm-cache");
    std::fs::create_dir_all(&cache).map_err(|e| format!("Cannot create the npm cache: {e}"))?;
    let user_config = cache.join("user.npmrc");
    files::write_atomic(&user_config, b"").map_err(|e| format!("Cannot stage the npm config: {e}"))?;
    let global_config = cache.join("global.npmrc");
    files::write_atomic(&global_config, b"").map_err(|e| format!("Cannot stage the npm config: {e}"))?;

    let mut command = TokioCommand::new(node);
    command
        .arg(npm_cli)
        .args([
            "ci",
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-progress",
            "--loglevel=error",
        ])
        .current_dir(dir)
        .env_clear();
    for (name, value) in spawn::sanitized_env() {
        command.env(name, value);
    }
    command
        .env("HOME", &paths.root)
        .env("npm_config_cache", cache.join("cache"))
        .env("npm_config_userconfig", &user_config)
        .env("npm_config_globalconfig", &global_config)
        .env("npm_config_registry", "https://registry.npmjs.org/")
        .env("npm_config_update_notifier", "false")
        .env("npm_config_ignore_scripts", "true");
    if let Some(url) = proxy_url() {
        // npm does not read the app's proxy settings, only its own environment.
        command.env("npm_config_proxy", url.as_str()).env("npm_config_https_proxy", url.as_str());
    }
    command.kill_on_drop(true);

    let output = timeout(NPM_TIMEOUT, command.output())
        .await
        .map_err(|_| "The Pi package install timed out.".to_string())?
        .map_err(|e| format!("Cannot start npm: {e}"))?;
    if !output.status.success() {
        let mut detail = tail(&output.stdout);
        detail.push_str(&tail(&output.stderr));
        return Err(if detail.trim().is_empty() {
            format!("npm ci exited with {}.", output.status)
        } else {
            format!("npm ci failed: {}", detail.trim())
        });
    }
    Ok(())
}

fn tail(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

async fn verify_stage(stage: &Path, paths: &PiPaths, version: &str) -> Result<(String, String), String> {
    let pi = stage.join("pi");
    let package_dir = pi.join("node_modules").join(PI_PACKAGE);
    let package: Value = serde_json::from_slice(
        &std::fs::read(package_dir.join("package.json")).map_err(|e| format!("Cannot read the installed Pi package: {e}"))?,
    )
    .map_err(|e| format!("Invalid installed Pi package: {e}"))?;
    if package.get("version").and_then(Value::as_str) != Some(version) {
        return Err(format!("The installed Pi version is not {version}."));
    }
    let cli_relative = installed_cli(&package)?;
    let cli = package_dir.join(&cli_relative);
    if !cli.is_file() {
        return Err(format!("The installed Pi CLI is missing: {}", cli.display()));
    }

    let mut command = TokioCommand::new(stage.join("node").join(if cfg!(windows) { "node.exe" } else { "node" }));
    command
        .arg(&cli)
        .arg("--version")
        .env_clear()
        .envs(spawn::sanitized_env())
        .env("HOME", &paths.root)
        .env("PI_CODING_AGENT_DIR", &paths.agent)
        .env("PI_SKIP_VERSION_CHECK", "1")
        .env("PI_OFFLINE", "1")
        .env("PI_TELEMETRY", "0")
        .kill_on_drop(true);
    let output = command.output().await.map_err(|e| format!("Cannot verify the installed Pi CLI: {e}"))?;
    let reported = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || !reported.contains(version) {
        return Err(format!("The installed Pi CLI did not report {version}: {}", if reported.is_empty() { tail(&output.stderr) } else { reported }));
    }

    // The analysis extension imports typebox from this tree; a missing
    // dependency would only surface on the first analysis otherwise.
    let mut extension = TokioCommand::new(stage.join("node").join(if cfg!(windows) { "node.exe" } else { "node" }));
    extension
        .args([
            "--input-type=module",
            "-e",
            "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.env.PI_UPDATE_EXTENSION).href);",
        ])
        .env_clear()
        .envs(spawn::sanitized_env())
        .env("PI_UPDATE_EXTENSION", stage.join("pi/extensions/tradepanel-analysis.mjs"))
        .env("HOME", &paths.root)
        .env("PI_CODING_AGENT_DIR", &paths.agent)
        .env("PI_SKIP_VERSION_CHECK", "1")
        .env("PI_OFFLINE", "1")
        .env("PI_TELEMETRY", "0")
        .kill_on_drop(true);
    let output = extension.output().await.map_err(|e| format!("Cannot verify the analysis extension: {e}"))?;
    if !output.status.success() {
        return Err(format!("The analysis extension failed to load: {}", tail(&output.stderr)));
    }

    let mut node_version_command = TokioCommand::new(stage.join("node").join(if cfg!(windows) { "node.exe" } else { "node" }));
    let output = node_version_command.arg("--version").output().await.map_err(|e| format!("Cannot check the staged Node version: {e}"))?;
    let node_version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !node_version.starts_with('v') || node_version.len() < 5 {
        return Err(format!("Unexpected staged Node version: {node_version}"));
    }
    let cli = cli_relative.to_string_lossy().replace('\\', "/");
    Ok((node_version, cli))
}

fn installed_cli(package: &Value) -> Result<PathBuf, String> {
    let bin = package.get("bin");
    let relative = bin
        .and_then(|b| b.as_str())
        .or_else(|| bin.and_then(|b| b.get("pi")).and_then(Value::as_str))
        .unwrap_or(PI_CLI);
    let path = Path::new(relative);
    if path.is_absolute() || path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("The installed Pi CLI path is not relative: {relative}"));
    }
    Ok(path.to_path_buf())
}

fn write_manifest(stage: &Path, target: &str, node_version: &str, pi_cli: &str, pi_version: &str) -> Result<(), String> {
    let manifest = json!({
        "schema": 1,
        "target": target,
        "nodeVersion": node_version,
        "piVersion": pi_version,
        "node": stage_node_relative(),
        "piCli": format!("pi/node_modules/{PI_PACKAGE}/{pi_cli}"),
        "npmCli": "npm/bin/npm-cli.js",
        "extension": "pi/extensions/tradepanel-analysis.mjs",
        "systemPrompt": "pi/prompts/analysis.md",
        "builtAt": Utc::now().to_rfc3339(),
    });
    files::write_atomic(&stage.join("manifest.json"), manifest.to_string().as_bytes())
        .map_err(|e| format!("Cannot write the runtime manifest: {e}"))
}

fn stage_node_relative() -> &'static str {
    if cfg!(windows) { "node/node.exe" } else { "node/node" }
}

/// A crash can leave a stage or the previous overlay's backup behind. They
/// are private to this app (only `<target>` is resolved) and safe to remove.
fn clean_stale_updates(runtime_root: &Path, target: &str) {
    for prefix in [format!(".update-{target}-"), format!(".backup-{target}-")] {
        let Ok(entries) = std::fs::read_dir(runtime_root) else { return };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&prefix) && entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

fn install_overlay(runtime_root: &Path, target: &str, stage: &Path) -> Result<(), String> {
    let overlay = runtime_root.join(target);
    let backup = if overlay.exists() {
        let backup = runtime_root.join(format!(".backup-{target}-{}", Utc::now().timestamp_millis()));
        std::fs::rename(&overlay, &backup).map_err(|e| format!("Cannot set the old runtime aside: {e}"))?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = std::fs::rename(stage, &overlay) {
        if let Some(backup) = &backup {
            let _ = std::fs::rename(backup, &overlay);
        }
        return Err(format!("Cannot install the updated runtime: {error}"));
    }
    if let Some(backup) = backup {
        let _ = std::fs::remove_dir_all(&backup);
    }
    Ok(())
}

/// Strict enough to use the version as a URL segment without encoding.
fn valid_version(version: &str) -> bool {
    let (core, suffix) = match version.split_once(['-', '+']) {
        Some((core, suffix)) => (core, Some(suffix)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    suffix.is_none_or(|suffix| {
        !suffix.is_empty()
            && !suffix.starts_with('.')
            && !suffix.ends_with('.')
            && suffix.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
    })
}

/// Numeric versions, then release over pre-release, then identifier by identifier.
fn version_order(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (left_core, left_pre) = split_version(left);
    let (right_core, right_pre) = split_version(right);
    match left_core.cmp(&right_core) {
        Ordering::Equal => match (left_pre, right_pre) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(a), Some(b)) => {
                let mut a = a.split('.');
                let mut b = b.split('.');
                loop {
                    match (a.next(), b.next()) {
                        (None, None) => return Ordering::Equal,
                        (None, Some(_)) => return Ordering::Less,
                        (Some(_), None) => return Ordering::Greater,
                        (Some(x), Some(y)) => {
                            let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                                (Ok(x), Ok(y)) => x.cmp(&y),
                                (Ok(_), Err(_)) => Ordering::Less,
                                (Err(_), Ok(_)) => Ordering::Greater,
                                _ => x.cmp(y),
                            };
                            if order != Ordering::Equal {
                                return order;
                            }
                        }
                    }
                }
            }
        },
        order => order,
    }
}

fn split_version(version: &str) -> ([u64; 3], Option<&str>) {
    let (core, pre) = match version.split_once(['-', '+']) {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let mut parts = [0u64; 3];
    for (index, part) in core.split('.').enumerate() {
        parts[index] = part.parse().unwrap_or(0);
    }
    (parts, pre)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn version_strings_are_safe_url_segments() {
        for version in ["1.5.0", "1.5.2", "2.0.0-beta.1", "1.5.2+build.4"] {
            assert!(valid_version(version), "{version}");
        }
        for version in ["", "1.5", "1.5.x", "../1.5.0", "1.5.0/evil", "1.5..0", "1.5.0-"] {
            assert!(!valid_version(version), "{version}");
        }
    }

    #[test]
    fn versions_compare_without_downgrading() {
        assert_eq!(version_order("1.5.2", "1.5.0"), Ordering::Greater);
        assert_eq!(version_order("1.5.2", "1.5.2"), Ordering::Equal);
        assert_eq!(version_order("1.5.0", "2.0.0"), Ordering::Less);
        assert_eq!(version_order("1.6.0", "1.10.0"), Ordering::Less);
        assert_eq!(version_order("1.5.2", "1.5.2-beta.1"), Ordering::Greater);
        assert_eq!(version_order("1.5.2-beta.2", "1.5.2-beta.10"), Ordering::Less);
    }

    #[test]
    fn release_files_must_pin_the_advertised_version() {
        let package = json!({ "version": "1.5.2", "dependencies": { PI_PACKAGE: "1.5.2" } }).to_string();
        let lock = json!({
            "lockfileVersion": 3,
            "packages": {
                "": { "dependencies": { PI_PACKAGE: "1.5.2" } },
                format!("node_modules/{PI_PACKAGE}"): { "version": "1.5.2" }
            }
        })
        .to_string();
        assert!(validate_release("1.5.2", &package, &lock).is_ok());
        assert!(validate_release("1.5.3", &package, &lock).is_err());
    }

    #[test]
    fn installed_cli_rejects_escaping_paths() {
        assert_eq!(installed_cli(&json!({ "bin": { "pi": "dist/bundle/cli.js" } })).unwrap(), Path::new(PI_CLI));
        assert!(installed_cli(&json!({ "bin": "../../evil.js" })).is_err());
        assert_eq!(installed_cli(&json!({})).unwrap(), Path::new(PI_CLI));
    }
}

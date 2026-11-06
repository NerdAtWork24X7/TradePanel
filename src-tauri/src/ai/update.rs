//! In-app updates for the bundled Pi coding agent.
//!
//! The runtime shipped in the application bundle is read-only when TradePanel
//! is installed system-wide, so an update installs a Pi tree into a writable
//! overlay (`<app-data>/ai/runtime/<target>`). Dependency resolution is not
//! reimplemented here: the npm CLI staged next to the bundled Node performs the
//! registry lookup and the install, with lifecycle scripts disabled and the
//! registry's own SHA-512 integrity data enforced.
//!
//! Safety properties:
//! * the install happens in a staging directory and is renamed over the overlay
//!   only after the new Pi CLI and the read-only extension both boot,
//! * a failed verification keeps the previous runtime,
//! * the update is refused when the release requires a newer Node than the
//!   bundled one,
//! * only one update runs at a time, and the child inherits the same sanitized
//!   environment as the analysis process (no trading credentials).

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::protocol::RpcErrorPayload;

use super::runtime::{compare_versions, AiRuntime, PI_CLI_RELATIVE, PI_PACKAGE};
use super::spawn;

/// Emitted while an update runs: `{ phase, message }`.
pub const UPDATE_EVENT: &str = "ai:runtime-update";

const VIEW_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const VERIFY_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_EVENT_CHARS: usize = 240;

/// Serializes installs across concurrent WebView invocations.
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUpdateInfo {
    pub package_name: String,
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub node_version: String,
    pub target: String,
    /// True when the active Pi tree already comes from an in-app update.
    pub managed: bool,
    pub dependency_count: Option<usize>,
}

#[derive(Debug, Clone)]
struct Release {
    version: String,
    node_requirement: Option<String>,
    dependency_count: Option<usize>,
}

fn unavailable(message: impl Into<String>) -> RpcErrorPayload {
    RpcErrorPayload::unavailable(message)
}

fn updates_root(app: &AppHandle) -> Result<PathBuf, RpcErrorPayload> {
    let data = app.path().app_data_dir().map_err(|error| {
        unavailable(format!(
            "Cannot resolve the application data directory: {error}"
        ))
    })?;
    Ok(data.join("ai").join("runtime"))
}

fn npm_cli(runtime: &AiRuntime) -> Result<PathBuf, RpcErrorPayload> {
    runtime.npm_cli.clone().ok_or_else(|| {
        unavailable(
            "This AI runtime was built without the npm updater. Install a newer TradePanel \
             release to update Pi from here.",
        )
    })
}

fn npm_command(app: &AppHandle, runtime: &AiRuntime) -> Result<Command, RpcErrorPayload> {
    let npm = npm_cli(runtime)?;
    let cache = updates_root(app)?.join("npm-cache");
    std::fs::create_dir_all(&cache)
        .map_err(|error| unavailable(format!("Cannot create the npm cache: {error}")))?;
    let mut command = Command::new(&runtime.node);
    command
        .arg(npm)
        .env_clear()
        .envs(spawn::sanitized_env())
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("npm_config_cache", cache.to_string_lossy().into_owned())
        .env("npm_config_update_notifier", "false")
        .env("npm_config_audit", "false")
        .env("npm_config_fund", "false")
        .env("npm_config_progress", "false")
        .env("npm_config_ignore_scripts", "true")
        .env("npm_config_loglevel", "warn")
        .current_dir(&cache)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    Ok(command)
}

fn view_args() -> Vec<String> {
    vec![
        "view".into(),
        format!("{PI_PACKAGE}@latest"),
        "version".into(),
        "engines".into(),
        "dependencies".into(),
        "--json".into(),
        "--no-update-notifier".into(),
    ]
}

fn install_args(prefix: &Path, version: &str) -> Vec<String> {
    vec![
        "install".into(),
        format!("{PI_PACKAGE}@{version}"),
        "--prefix".into(),
        prefix.to_string_lossy().into_owned(),
        "--omit=dev".into(),
        "--ignore-scripts".into(),
        "--no-audit".into(),
        "--no-fund".into(),
        "--no-update-notifier".into(),
        "--no-progress".into(),
        "--save-exact".into(),
        "--loglevel=warn".into(),
    ]
}

/// Latest release metadata from the npm registry.
async fn latest_release(app: &AppHandle, runtime: &AiRuntime) -> Result<Release, RpcErrorPayload> {
    let mut command = npm_command(app, runtime)?;
    command.args(view_args());
    let output = tokio::time::timeout(VIEW_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            unavailable("Timed out while asking the npm registry for the latest Pi release.")
        })?
        .map_err(|error| unavailable(format!("Cannot start the npm updater: {error}")))?;
    if !output.status.success() {
        return Err(unavailable(format!(
            "npm could not reach the registry: {}",
            tail(&output.stderr)
        )));
    }
    parse_release(&output.stdout)
}

fn parse_release(bytes: &[u8]) -> Result<Release, RpcErrorPayload> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| unavailable(format!("Unexpected npm registry response: {error}")))?;
    // `view <pkg>@latest` yields an object; keep working if npm ever answers
    // with a single-element array instead.
    let entry = match &value {
        Value::Array(entries) => entries.last(),
        Value::Object(_) => Some(&value),
        _ => None,
    }
    .ok_or_else(|| unavailable("The npm registry returned no Pi release metadata."))?;
    let version = entry
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| unavailable("The npm registry returned no Pi version."))?;
    if !version.starts_with(|character: char| character.is_ascii_digit()) {
        return Err(unavailable(format!(
            "Unexpected Pi version from the npm registry: {version}"
        )));
    }
    let node_requirement = entry
        .get("engines")
        .and_then(|engines| engines.get("node"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let dependency_count = entry
        .get("dependencies")
        .and_then(Value::as_object)
        .map(|dependencies| dependencies.len());
    Ok(Release {
        version: version.to_string(),
        node_requirement,
        dependency_count,
    })
}

/// Lowest `>=X.Y.Z` floor in a Node engine range. Ranges with only `^`/`~` or
/// no lower bound yield `None` (nothing to enforce).
fn required_node_floor(spec: &str) -> Option<String> {
    let mut floor: Option<String> = None;
    for token in spec
        .split(|character: char| character.is_whitespace() || character == ',' || character == '|')
    {
        let Some(version) = token.trim().strip_prefix(">=") else {
            continue;
        };
        let version = version.trim().trim_start_matches('v');
        if version.is_empty() || !version.starts_with(|character: char| character.is_ascii_digit())
        {
            continue;
        }
        if floor
            .as_deref()
            .is_none_or(|current| compare_versions(version, current) == Ordering::Greater)
        {
            floor = Some(version.to_string());
        }
    }
    floor
}

pub async fn check(
    app: &AppHandle,
    runtime: &AiRuntime,
) -> Result<RuntimeUpdateInfo, RpcErrorPayload> {
    let release = latest_release(app, runtime).await?;
    Ok(RuntimeUpdateInfo {
        package_name: PI_PACKAGE.to_string(),
        current_version: runtime.pi_version.clone(),
        available: compare_versions(&release.version, &runtime.pi_version) == Ordering::Greater,
        latest_version: release.version,
        node_version: runtime.node_version.clone(),
        target: runtime.target.clone(),
        managed: runtime.is_overlay(),
        dependency_count: release.dependency_count,
    })
}

pub async fn install(
    app: &AppHandle,
    runtime: &AiRuntime,
) -> Result<RuntimeUpdateInfo, RpcErrorPayload> {
    let _guard = InstallGuard::acquire()?;
    let release = latest_release(app, runtime).await?;
    if compare_versions(&release.version, &runtime.pi_version) != Ordering::Greater {
        return Err(unavailable(format!(
            "Pi {} is already the latest release.",
            runtime.pi_version
        )));
    }
    if let Some(floor) = release
        .node_requirement
        .as_deref()
        .and_then(required_node_floor)
    {
        if compare_versions(runtime.node_version.trim_start_matches('v'), &floor) == Ordering::Less
        {
            return Err(unavailable(format!(
                "Pi {} requires Node {floor} or newer; the bundled runtime has {}. \
                 Update TradePanel to get a newer Node.",
                release.version, runtime.node_version
            )));
        }
    }

    let updates = updates_root(app)?;
    std::fs::create_dir_all(&updates)
        .map_err(|error| unavailable(format!("Cannot create the AI update folder: {error}")))?;
    remove_leftovers(&updates);
    let overlay = updates.join(&runtime.target);
    let stamp = now_ms();
    let staging = updates.join(format!(".staging-{}-{stamp}", std::process::id()));
    let previous = updates.join(format!(".previous-{stamp}"));
    let staging_pi = staging.join("pi");
    let result = stage_and_install(
        app,
        runtime,
        &release,
        &staging_pi,
        &overlay,
        &staging,
        &previous,
    )
    .await;
    let _ = std::fs::remove_dir_all(&staging);
    let info = result?;
    emit(
        app,
        "done",
        format!("Pi {} is active.", info.current_version),
    );
    Ok(info)
}

async fn stage_and_install(
    app: &AppHandle,
    runtime: &AiRuntime,
    release: &Release,
    staging_pi: &Path,
    overlay: &Path,
    staging: &Path,
    previous: &Path,
) -> Result<RuntimeUpdateInfo, RpcErrorPayload> {
    let base_pi = runtime.base_root.join("pi");
    emit(app, "prepare", format!("Preparing Pi {}…", release.version));
    // Copy the read-only bridge (extension, prompt, settings service) so module
    // resolution inside the staging tree finds the freshly installed packages.
    for directory in ["extensions", "prompts"] {
        let source = base_pi.join(directory);
        if !source.is_dir() {
            return Err(unavailable(format!(
                "The bundled AI runtime is incomplete: {} is missing.",
                source.display()
            )));
        }
        copy_tree(&source, &staging_pi.join(directory))
            .map_err(|error| unavailable(format!("Cannot stage the AI runtime: {error}")))?;
    }
    for file in ["settings-service.mjs", "package.json"] {
        let source = base_pi.join(file);
        if !source.is_file() {
            if file == "settings-service.mjs" {
                continue;
            }
            return Err(unavailable(format!(
                "The bundled AI runtime is incomplete: {} is missing.",
                source.display()
            )));
        }
        std::fs::copy(&source, staging_pi.join(file))
            .map_err(|error| unavailable(format!("Cannot stage the AI runtime: {error}")))?;
    }

    emit(
        app,
        "install",
        format!(
            "Downloading {} {} and its npm dependencies…",
            PI_PACKAGE, release.version
        ),
    );
    run_npm_install(app, runtime, release, staging_pi).await?;

    emit(
        app,
        "verify",
        "Verifying the updated Pi runtime…".to_string(),
    );
    verify_install(runtime, release, staging_pi).await?;

    let extension = base_relative(runtime, &runtime.extension)?;
    let system_prompt = base_relative(runtime, &runtime.system_prompt)?;
    let settings_service = runtime
        .settings_service
        .as_ref()
        .map(|path| base_relative(runtime, path))
        .transpose()?;
    let manifest = json!({
        "schema": 2,
        "kind": "overlay",
        "target": runtime.target,
        "piVersion": release.version,
        "pi": "pi",
        "piCli": format!("pi/{PI_CLI_RELATIVE}"),
        "extension": extension,
        "systemPrompt": system_prompt,
        "settingsService": settings_service,
        "builtAt": built_at_stamp(),
    });
    std::fs::write(
        staging.join("manifest.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).unwrap_or_default()
        ),
    )
    .map_err(|error| unavailable(format!("Cannot write the AI update manifest: {error}")))?;

    // Activate: keep the old tree until the new one is in place, and restore it
    // if the rename fails (Windows refuses renames over open files).
    if overlay.exists() {
        std::fs::rename(overlay, previous)
            .map_err(|error| unavailable(format!("Cannot replace the AI update: {error}")))?;
    }
    if let Err(error) = std::fs::rename(staging, overlay) {
        if previous.exists() {
            let _ = std::fs::rename(previous, overlay);
        }
        return Err(unavailable(format!(
            "Cannot activate the AI update: {error}. Stop the AI runtime and try again."
        )));
    }
    let _ = std::fs::remove_dir_all(previous);
    log::info!("AI runtime updated to Pi {}", release.version);

    Ok(RuntimeUpdateInfo {
        package_name: PI_PACKAGE.to_string(),
        current_version: release.version.clone(),
        latest_version: release.version.clone(),
        available: false,
        node_version: runtime.node_version.clone(),
        target: runtime.target.clone(),
        managed: true,
        dependency_count: release.dependency_count,
    })
}

async fn run_npm_install(
    app: &AppHandle,
    runtime: &AiRuntime,
    release: &Release,
    staging_pi: &Path,
) -> Result<(), RpcErrorPayload> {
    let mut command = npm_command(app, runtime)?;
    command
        .args(install_args(staging_pi, &release.version))
        .current_dir(staging_pi);
    let mut child = command
        .spawn()
        .map_err(|error| unavailable(format!("Cannot start the npm updater: {error}")))?;
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let stderr_pump = pump(app.clone(), stderr);
    let stdout_pump = pump(app.clone(), stdout);
    let status = tokio::time::timeout(INSTALL_TIMEOUT, child.wait()).await;
    let _ = tokio::join!(stderr_pump, stdout_pump);
    match status {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(unavailable(format!(
            "npm could not install Pi {} ({status}). Check the network connection and try again.",
            release.version
        ))),
        Ok(Err(error)) => Err(unavailable(format!("The npm updater failed: {error}"))),
        Err(_) => {
            let _ = child.start_kill();
            Err(unavailable(
                "The Pi update timed out after 15 minutes. Check the network connection and try again.",
            ))
        }
    }
}

/// Forward npm's output to the settings page. Progress bars use `\r`; split on
/// both separators and keep lines bounded.
fn pump<R>(app: AppHandle, stream: Option<R>) -> tauri::async_runtime::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let Some(stream) = stream else { return };
        let mut reader = BufReader::with_capacity(8 * 1024, stream);
        let mut buffer = Vec::with_capacity(1024);
        loop {
            buffer.clear();
            match reader.read_until(b'\n', &mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            for part in String::from_utf8_lossy(&buffer).split(['\r', '\n']) {
                let line = clean_line(part);
                if !line.is_empty() {
                    emit(&app, "install", line);
                }
            }
        }
    })
}

async fn verify_install(
    runtime: &AiRuntime,
    release: &Release,
    staging_pi: &Path,
) -> Result<(), RpcErrorPayload> {
    let package_json = staging_pi
        .join("node_modules")
        .join(PI_PACKAGE)
        .join("package.json");
    let text = std::fs::read_to_string(&package_json).map_err(|error| {
        unavailable(format!(
            "npm did not install Pi {}: {error}",
            release.version
        ))
    })?;
    let installed: Value = serde_json::from_str(&text)
        .map_err(|error| unavailable(format!("Installed Pi metadata is invalid: {error}")))?;
    let installed_version = installed
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if installed_version != release.version {
        return Err(unavailable(format!(
            "npm installed Pi {installed_version} instead of {}.",
            release.version
        )));
    }

    let cli = staging_pi.join(PI_CLI_RELATIVE);
    let mut probe = Command::new(&runtime.node);
    probe
        .arg(&cli)
        .arg("--version")
        .env_clear()
        .envs(spawn::sanitized_env())
        .env("PI_OFFLINE", "1")
        .env("PI_SKIP_VERSION_CHECK", "1")
        .env("PI_TELEMETRY", "0")
        .current_dir(staging_pi)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        probe.creation_flags(0x0800_0000);
    }
    let output = tokio::time::timeout(VERIFY_TIMEOUT, probe.output())
        .await
        .map_err(|_| unavailable("The updated Pi runtime did not answer in time."))?
        .map_err(|error| unavailable(format!("Cannot start the updated Pi runtime: {error}")))?;
    if !output.status.success() {
        return Err(unavailable(format!(
            "The updated Pi runtime exited with {}: {}",
            output.status,
            tail(&output.stderr)
        )));
    }
    let reported = String::from_utf8_lossy(&output.stdout);
    if !reported.contains(&release.version) {
        return Err(unavailable(format!(
            "The updated Pi runtime reported an unexpected version: {}",
            clean_line(reported.trim())
        )));
    }

    // The extension and the settings bridge must resolve their imports from the
    // new tree; a missing transitive package would otherwise only surface on the
    // first analysis.
    let extension_name = runtime
        .extension
        .file_name()
        .ok_or_else(|| unavailable("The bundled AI runtime has no analysis extension."))?;
    let extension_file = staging_pi.join("extensions").join(extension_name);
    if !extension_file.is_file() {
        return Err(unavailable(format!(
            "The analysis extension is missing after the update: {}",
            extension_file.display()
        )));
    }
    let mut load = Command::new(&runtime.node);
    load.arg("--input-type=module")
        .arg("-e")
        .arg("await import(process.argv[1])")
        .arg(&extension_file)
        .env_clear()
        .envs(spawn::sanitized_env())
        .env("PI_OFFLINE", "1")
        .env("PI_TELEMETRY", "0")
        .current_dir(staging_pi)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        load.creation_flags(0x0800_0000);
    }
    let output = tokio::time::timeout(VERIFY_TIMEOUT, load.output())
        .await
        .map_err(|_| unavailable("The analysis extension did not load in time."))?
        .map_err(|error| unavailable(format!("Cannot verify the analysis extension: {error}")))?;
    if !output.status.success() {
        return Err(unavailable(format!(
            "The updated Pi runtime cannot load the analysis extension: {}",
            tail(&output.stderr)
        )));
    }

    let settings_service = staging_pi.join("settings-service.mjs");
    if settings_service.is_file() {
        let mut check = Command::new(&runtime.node);
        check
            .arg("--check")
            .arg(&settings_service)
            .env_clear()
            .envs(spawn::sanitized_env())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            check.creation_flags(0x0800_0000);
        }
        let output = tokio::time::timeout(VERIFY_TIMEOUT, check.output())
            .await
            .map_err(|_| unavailable("The provider settings bridge did not check in time."))?
            .map_err(|error| unavailable(format!("Cannot verify the settings bridge: {error}")))?;
        if !output.status.success() {
            return Err(unavailable(format!(
                "The updated Pi runtime broke the provider settings bridge: {}",
                tail(&output.stderr)
            )));
        }
    }
    Ok(())
}

fn base_relative(runtime: &AiRuntime, path: &Path) -> Result<String, RpcErrorPayload> {
    let relative = path.strip_prefix(&runtime.base_root).map_err(|_| {
        unavailable(format!(
            "The AI runtime path is outside the bundle: {}",
            path.display()
        ))
    })?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn copy_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn remove_leftovers(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".staging-") || name.starts_with(".previous-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn emit(app: &AppHandle, phase: &str, message: impl Into<String>) {
    let message = clean_line(&message.into());
    if message.is_empty() {
        return;
    }
    log::info!(target: "ai-update", "{phase}: {message}");
    if let Err(error) = app.emit(UPDATE_EVENT, &json!({ "phase": phase, "message": message })) {
        log::warn!("Cannot emit AI update progress: {error}");
    }
}

fn clean_line(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_EVENT_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "no error output".to_string();
    }
    // Slice by chars, not bytes: npm output may contain non-ASCII paths.
    let bounded: String = trimmed
        .chars()
        .rev()
        .take(MAX_EVENT_CHARS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    clean_line(&bounded)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn built_at_stamp() -> String {
    // No chrono dependency: a millisecond epoch stamp is enough for the overlay
    // manifest, which only humans read.
    format!("{}ms", now_ms())
}

struct InstallGuard;

impl InstallGuard {
    fn acquire() -> Result<Self, RpcErrorPayload> {
        if INSTALLING.swap(true, AtomicOrdering::SeqCst) {
            return Err(unavailable("An AI runtime update is already running."));
        }
        Ok(Self)
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, AtomicOrdering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_metadata() {
        let release = parse_release(
            br#"{"version":"1.6.0","engines":{"node":">=22.19.0"},"dependencies":{"a":"1","b":"2"}}"#,
        )
        .unwrap();
        assert_eq!(release.version, "1.6.0");
        assert_eq!(release.node_requirement.as_deref(), Some(">=22.19.0"));
        assert_eq!(release.dependency_count, Some(2));

        let array = parse_release(br#"[{"version":"1.6.1"}]"#).unwrap();
        assert_eq!(array.version, "1.6.1");
        assert!(array.node_requirement.is_none());
        assert!(parse_release(br#"{"version":"latest"}"#).is_err());
        assert!(parse_release(b"not json").is_err());
        assert!(parse_release(b"{}").is_err());
    }

    #[test]
    fn finds_the_node_engine_floor() {
        assert_eq!(required_node_floor(">=22.19.0").as_deref(), Some("22.19.0"));
        assert_eq!(
            required_node_floor(">=20.0.0 <21 || >=22.19.0").as_deref(),
            Some("22.19.0")
        );
        assert_eq!(required_node_floor("^22.19.0"), None);
        assert_eq!(required_node_floor(""), None);
    }

    #[test]
    fn npm_invocations_never_run_lifecycle_scripts() {
        let args = install_args(Path::new("/tmp/runtime/pi"), "1.6.0");
        assert!(args.iter().any(|arg| arg == "--ignore-scripts"));
        assert!(args.iter().any(|arg| arg == "--omit=dev"));
        assert!(args.iter().any(|arg| arg == &format!("{PI_PACKAGE}@1.6.0")));
        let view = view_args();
        assert!(view.iter().any(|arg| arg == "--json"));
        assert!(view.contains(&format!("{PI_PACKAGE}@latest")));
    }

    #[test]
    fn tails_multibyte_output_without_splitting_a_character() {
        let bytes = "npm échec — réseau".repeat(80).into_bytes();
        let text = tail(&bytes);
        assert!(text.chars().count() <= MAX_EVENT_CHARS);
        assert!(text.ends_with("réseau"));
        assert_eq!(tail(&[]), "no error output");
    }

    #[test]
    fn trims_and_bounds_progress_lines() {
        assert_eq!(clean_line("  added 12 packages\r"), "added 12 packages");
        assert_eq!(clean_line("a\u{1b}[32mb\u{7}"), "a[32mb");
        assert!(clean_line(&"x".repeat(500)).chars().count() <= MAX_EVENT_CHARS);
    }
}

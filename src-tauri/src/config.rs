//! Application paths and one-time import of legacy data.
//!
//! User data never lives inside the installation directory. On first run any
//! legacy `data/` directory found next to the old executable/repository is
//! *copied* into the OS app-data directory (existing files win), including the
//! SQLite WAL/SHM companions. The legacy directory is never modified.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub keys_dir: PathBuf,
}

pub fn prepare(app: &AppHandle) -> Result<AppPaths, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve the application data directory: {error}"))?;
    let data_dir = root.join("data");
    let keys_dir = root.join("keys");
    for dir in [&root, &data_dir, &keys_dir] {
        fs::create_dir_all(dir).map_err(|error| {
            format!("Cannot create {}: {error}", dir.display())
        })?;
    }
    restrict_permissions(&keys_dir);

    if let Some(legacy) = find_legacy_data_dir(&data_dir) {
        match copy_missing(&legacy, &data_dir) {
            Ok(0) => log::info!("Legacy data directory already imported: {}", legacy.display()),
            Ok(count) => log::warn!(
                "Imported {count} file(s) from legacy data directory {} into {}",
                legacy.display(),
                data_dir.display()
            ),
            Err(error) => log::error!(
                "Legacy data import from {} failed: {error}",
                legacy.display()
            ),
        }
    }

    Ok(AppPaths { data_dir, keys_dir })
}

/// Resolve the packaged one-folder sidecar executable.
///
/// Packaged: `<resource_dir>/backend/tradepanel-backend[.exe]`.
/// Development (`cargo run` / `tauri dev`): `<src-tauri>/backend-dist/...`.
pub fn sidecar_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "tradepanel-backend.exe"
    } else {
        "tradepanel-backend"
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(value) = std::env::var("TRADEPANEL_BACKEND_BIN") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("backend").join(name));
        candidates.push(resource_dir.join("backend-dist").join("tradepanel-backend").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("backend").join(name));
            candidates.push(dir.join("backend-dist").join("tradepanel-backend").join(name));
        }
    }
    // Development and CI: `cargo run --release` does not stage bundle resources.
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("backend-dist")
            .join("tradepanel-backend")
            .join(name),
    );
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "Python backend executable not found. Build it with `scripts/build-backend.sh` (or the PowerShell equivalent). Tried: {}",
        candidates
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn restrict_permissions(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Candidate legacy data directories, most specific first.
pub fn find_legacy_data_dir(target: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(value) = std::env::var("TRADEPANEL_LEGACY_DATA_DIR") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("data"));
        candidates.push(cwd.join("..").join("data"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("data"));
        }
    }
    if cfg!(debug_assertions) {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data"));
    }

    let target_canonical = target.canonicalize().ok();
    for candidate in candidates {
        if !candidate.is_dir() {
            continue;
        }
        let canonical = candidate.canonicalize().ok();
        if canonical.is_some() && canonical == target_canonical {
            continue;
        }
        return Some(candidate);
    }
    None
}

/// Recursively copy files that do not exist in the destination.
/// Returns the number of copied files.
pub fn copy_missing(source: &Path, target: &Path) -> std::io::Result<usize> {
    let mut copied = 0usize;
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let destination = target.join(&name);
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copied += copy_missing(&path, &destination)?;
        } else if file_type.is_file() {
            if destination.exists() {
                continue;
            }
            match fs::copy(&path, &destination) {
                Ok(_) => {
                    copied += 1;
                    // Keep the user-only permissions of the original where possible.
                    if let Ok(meta) = fs::metadata(&destination) {
                        let mut permissions = meta.permissions();
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            permissions.set_mode(0o600);
                        }
                        let _ = fs::set_permissions(&destination, permissions);
                    }
                }
                Err(error) => {
                    log::warn!("Could not copy {}: {error}", path.display());
                }
            }
        }
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_missing_does_not_overwrite_and_keeps_wal_files() {
        let base = std::env::temp_dir().join(format!(
            "tradepanel-copy-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let source = base.join("source");
        let target = base.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("candles_1m.db"), b"new").unwrap();
        fs::write(source.join("candles_1m.db-wal"), b"wal").unwrap();
        fs::write(target.join("candles_1m.db"), b"user").unwrap();

        let copied = copy_missing(&source, &target).unwrap();
        assert_eq!(copied, 1);
        assert_eq!(fs::read(target.join("candles_1m.db")).unwrap(), b"user");
        assert_eq!(fs::read(target.join("candles_1m.db-wal")).unwrap(), b"wal");
        fs::remove_dir_all(base).unwrap();
    }
}

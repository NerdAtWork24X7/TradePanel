/*!
 * The plugins that ship inside the app (the standalone build): installed in the app's data
 * folder the first time it runs, with the Python runtime they need.
 *
 * The bundle carries them under the resource directory:
 *
 * ```text
 * <resources>/plugins/plugins.json            which plugins, and which of them start
 * <resources>/plugins/packages/<id>/          a plugin's package (its manifest among the files)
 * <resources>/plugins/runtime/python/         the Python the plugins run under
 * <resources>/plugins/runtime/site-packages/  their dependencies
 * ```
 *
 * A plugin already in the data folder is left alone: the user's copy wins, and the bundled
 * one is only installed when it is missing. A build without bundled plugins (the ordinary
 * one) finds nothing here and does nothing.
 */
use super::{apply, new_token, read_config, write_config, Config, PluginConfig, Plugins};
use opentrader_core::files;
use opentrader_core::sync::LockExt;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Install the bundled plugins, in the background: the first run copies the Python runtime
/// (a few hundred megabytes), which the window should not wait for.
pub fn install(app: &AppHandle) {
    let Some(bundled) = bundled_dir(app) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = install_bundled(&app, &bundled) {
            eprintln!("opentrader: the bundled plugins could not be installed: {e}");
        }
    });
}

/// The bundled plugins in the resource directory, when the build put them there.
fn bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("plugins");
    dir.join("packages").is_dir().then_some(dir)
}

fn install_bundled(app: &AppHandle, bundled: &Path) -> Result<(), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let plugins_dir = data.join("plugins");
    std::fs::create_dir_all(&plugins_dir).map_err(|e| e.to_string())?;

    // The Python the plugins run under, shared by all of them.
    let venv = runtime_venv(bundled, &plugins_dir)?;

    let packages = bundled.join("packages");
    let mut ids: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(&packages).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let target = plugins_dir.join(&id);
        if !target.exists() {
            copy_tree(&entry.path(), &target)?;
        }
        // The plugin runs under the shared environment.
        if let Some(venv) = &venv {
            link_dir(venv, &target.join(".venv"))?;
        }
        ids.push(id);
    }

    register(app, bundled, &ids)?;
    eprintln!("opentrader: the bundled plugins are in {}", plugins_dir.display());
    Ok(())
}

/// The environment the plugins run under: the bundled Python, copied into the data folder and
/// given an environment of its own with the plugins' dependencies in it.
fn runtime_venv(bundled: &Path, plugins_dir: &Path) -> Result<Option<PathBuf>, String> {
    let source = bundled.join("runtime");
    if !source.join("python").is_dir() {
        return Ok(None);
    }
    let runtime = plugins_dir.join(".runtime");
    let python = runtime.join("python");
    let venv = runtime.join("venv");
    if !python.is_dir() {
        std::fs::create_dir_all(&runtime).map_err(|e| e.to_string())?;
        copy_tree(&source.join("python"), &python)?;
    }
    if !venv.is_dir() {
        create_venv(&python, &venv)?;
        // The dependencies, inside the environment the plugins run under.
        let deps = source.join("site-packages");
        if deps.is_dir() {
            copy_tree(&deps, &purelib(&venv)?)?;
        }
    }
    Ok(Some(venv))
}

/// The interpreter of a Python installation: `bin/python3` on Unix, `python.exe` on Windows.
fn python_exe(python: &Path) -> Option<PathBuf> {
    if cfg!(windows) {
        let exe = python.join("python.exe");
        return exe.is_file().then_some(exe);
    }
    ["python3", "python"]
        .iter()
        .map(|name| python.join("bin").join(name))
        .find(|exe| exe.is_file())
}

/// The interpreter of an environment: `bin/python` on Unix, `Scripts/python.exe` on Windows.
fn venv_python(venv: &Path) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["Scripts/python.exe"] } else { &["bin/python"] };
    names.iter().map(|n| venv.join(n)).find(|p| p.is_file())
}

/// An environment for the bundled Python. It is created where it stays, so its paths are the
/// ones it will be used with.
fn create_venv(python: &Path, venv: &Path) -> Result<(), String> {
    let exe = python_exe(python).ok_or("the bundled Python has no interpreter")?;
    let status = std::process::Command::new(&exe)
        .args(["-m", "venv", "--without-pip", &venv.to_string_lossy()])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("the bundled Python could not create its environment ({status})"));
    }
    Ok(())
}

/// Where the environment keeps its packages: the environment itself decides.
fn purelib(venv: &Path) -> Result<PathBuf, String> {
    let exe = venv_python(venv).ok_or("the environment has no interpreter")?;
    let out = std::process::Command::new(exe)
        .args(["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("the environment does not tell where its packages are".into());
    }
    Ok(PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
}

/// Copy a folder, file by file. A symlink is copied as the file it points at: the copy must
/// work on its own, wherever the bundle was moved to.
fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
        }
    }
    Ok(())
}

/// Point a folder at another one: a symbolic link on Unix, a junction on Windows (which
/// needs no privileges).
#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(link).is_ok() {
        return Ok(());
    }
    std::os::unix::fs::symlink(target, link).map_err(|e| format!("{}: {e}", link.display()))
}

#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(link).is_ok() {
        return Ok(());
    }
    // The paths are quoted: `cmd` reads the line, not the arguments.
    let status = std::process::Command::new("cmd")
        .args([
            "/c",
            "mklink",
            "/J",
            &format!("\"{}\"", link.display()),
            &format!("\"{}\"", target.display()),
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("could not link {}", link.display()));
    }
    Ok(())
}

/// Write the bundled plugins into the app's settings: the ones the bundle starts, with a token
/// of their own. A plugin the user already has keeps its settings and its token.
fn register(app: &AppHandle, bundled: &Path, ids: &[String]) -> Result<(), String> {
    let template: Config = files::load_or_default(&bundled.join("plugins.json"));
    let mut config = read_config(app);
    if !merge(&template, &mut config, ids)? {
        return Ok(());
    }
    write_config(app, &config)?;
    // The running app follows the settings that were just written.
    let state = app.state::<Plugins>();
    *state.config.locked() = config;
    apply(app);
    Ok(())
}

/// Add the plugins of the bundle that are not installed yet: the ones the bundle starts, with
/// a token of their own. A plugin the user already has keeps its settings and its token.
/// Returns whether anything was added.
fn merge(template: &Config, config: &mut Config, ids: &[String]) -> Result<bool, String> {
    let mut changed = false;
    for id in ids {
        if config.plugins.contains_key(id) {
            continue;
        }
        let Some(bundled) = template.plugins.get(id) else { continue };
        config.plugins.insert(
            id.clone(),
            PluginConfig {
                enabled: bundled.enabled,
                token: new_token()?,
                ..Default::default()
            },
        );
        changed = true;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(plugins: &[(&str, bool)]) -> Config {
        let mut config = Config::default();
        for (id, enabled) in plugins {
            config.plugins.insert(
                (*id).to_string(),
                PluginConfig { enabled: *enabled, token: format!("token-{id}"), ..Default::default() },
            );
        }
        config
    }

    #[test]
    fn the_bundled_plugins_are_added_with_the_switches_of_the_bundle() {
        let template = config(&[("crypto", true), ("kraken", false)]);
        let mut config = Config::default();
        let changed = merge(&template, &mut config, &["crypto".into(), "kraken".into()]).unwrap();
        assert!(changed);
        assert!(config.plugins["crypto"].enabled);
        assert!(!config.plugins["kraken"].enabled);
        // The token is the app's own: the one in the bundle is not used.
        assert!(!config.plugins["crypto"].token.is_empty());
        assert_ne!(config.plugins["crypto"].token, template.plugins["crypto"].token);
    }

    #[test]
    fn a_plugin_the_user_already_has_keeps_its_settings() {
        let template = config(&[("crypto", true)]);
        let mut config = config(&[("crypto", false)]);
        config.plugins.get_mut("crypto").unwrap().settings.insert("network".into(), "live".into());
        let changed = merge(&template, &mut config, &["crypto".into()]).unwrap();
        assert!(!changed);
        assert!(!config.plugins["crypto"].enabled);
        assert_eq!(config.plugins["crypto"].settings["network"], "live");
        assert_eq!(config.plugins["crypto"].token, "token-crypto");
    }

    #[test]
    fn a_folder_is_copied_with_its_files() {
        let dir = std::env::temp_dir().join(format!("opentrader-bundled-test-{}", std::process::id()));
        let from = dir.join("from");
        std::fs::create_dir_all(from.join("nested")).unwrap();
        std::fs::write(from.join("plugin.py"), "print('hi')").unwrap();
        std::fs::write(from.join("nested/manifest.json"), "{}").unwrap();
        let to = dir.join("to");
        copy_tree(&from, &to).unwrap();
        assert_eq!(std::fs::read_to_string(to.join("plugin.py")).unwrap(), "print('hi')");
        assert!(to.join("nested/manifest.json").is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

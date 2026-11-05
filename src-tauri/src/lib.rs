mod commands;
mod config;
mod events;
mod protocol;
mod security;
mod sidecar;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};

use commands::AppState;
use security::SecretStore;
use sidecar::SidecarManager;

pub fn run() {
    let updater_pubkey = option_env!("TRADEPANEL_UPDATER_PUBKEY")
        .unwrap_or("")
        .trim()
        .to_string();
    let updater_enabled = !updater_pubkey.is_empty();
    commands::set_updater_configured(updater_enabled);

    let log_dir_target = Target::new(TargetKind::LogDir {
        file_name: Some("tradepanel".to_string()),
    });

    let mut builder = tauri::Builder::default()
        // single-instance must be registered first: it prevents a second app
        // instance (and therefore a second backend sidecar) from starting.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stderr),
                    log_dir_target,
                ])
                .build(),
        );

    if updater_enabled {
        builder = builder.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(updater_pubkey)
                .build(),
        );
    }

    let app = builder
        .setup(|app| {
            let paths = config::prepare(app.handle()).map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    error,
                ))
            })?;
            let credentials = Arc::new(SecretStore::new());
            let version = app.package_info().version.to_string();
            let binary = config::sidecar_binary(app.handle())?;
            let sidecar = SidecarManager::new(
                app.handle().clone(),
                binary,
                paths.data_dir.clone(),
                paths.keys_dir.clone(),
                version,
                credentials.clone(),
            );
            app.manage(AppState {
                sidecar: sidecar.clone(),
                credentials,
                orders: commands::OrderGate::new(paths.data_dir.join("trading_state.json")),
                data_dir: paths.data_dir.clone(),
            });
            log::info!(
                "TradePanel {} starting (data dir: {})",
                app.package_info().version,
                paths.data_dir.display()
            );
            sidecar.start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::backend_status,
            commands::backend_restart,
            commands::backend_rpc,
            commands::orders_acknowledge,
            commands::orders_state,
            commands::credentials_status,
            commands::credentials_save,
            commands::credentials_legacy_status,
            commands::credentials_import_legacy,
            commands::app_info,
            commands::open_trade_page,
            commands::set_fullscreen,
            commands::log_frontend,
            commands::update_check,
            commands::update_install,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the TradePanel application");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            let manager = handle.state::<AppState>().sidecar.clone();
            tauri::async_runtime::block_on(async move {
                manager.shutdown().await;
            });
        }
    });
}

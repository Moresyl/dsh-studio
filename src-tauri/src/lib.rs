//! dsh-studio — a native desktop shell for the DeepSeek Harness.

mod about;
mod application_menu;
mod atomic;
mod desktop;
mod diagnostics;
mod error;
mod fetch;
mod harness;
mod locale;
mod logging;
mod material;
mod node;
mod offline;
mod paths;
mod plugins;
mod presets;
mod profiles;
mod recovery;
mod remote;
mod sessions;
mod startup;
mod terminal;
mod tray;
mod window;
mod workspace;

use std::sync::Arc;

use tauri::{Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;

use harness::commands::AppState;
use harness::supervisor::{Event, Status, Supervisor};
use node::NodeJobs;
use plugins::{PluginIntents, PluginJobs};
use remote::Remote;

/// Channel the frontend listens on for supervisor status and log events.
const EVENT_CHANNEL: &str = "harness://event";

/// Channel the remote panel listens on for connection counts.
const REMOTE_CHANNEL: &str = "remote://changed";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::install_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch surfaces the running app instead of starting
            // another harness — two would fight over the same session store.
            // Opening another window is a thing this app does; it is just not
            // something starting the binary twice should be taken to mean.
            if let Some(existing) = window::front(app) {
                window::reveal(&existing);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        // The flag is the whole of what the login item is told, and it is what
        // keeps a launch nobody asked to see from putting a window on screen —
        // see `startup::standby`, which is the only reader.
        .plugin(tauri_plugin_autostart::init(
            // AppleScript creates a real macOS Login Item (visible to System
            // Settings and third-party startup managers). Other platforms use
            // their native registry/desktop-file implementation.
            #[cfg(target_os = "macos")]
            tauri_plugin_autostart::MacosLauncher::AppleScript,
            #[cfg(not(target_os = "macos"))]
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![startup::STANDBY_FLAG]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Before a profile can be started or shown as healthy. The recovery
            // result is persisted and the first window explains it.
            let _ = plugins::recovery::recover_startup();
            let supervisor = Supervisor::new()?;
            let remote = Arc::new(Remote::new());

            forward_events(app.handle(), &supervisor, &remote);
            forward_remote_changes(app.handle(), &remote);

            app.manage(AppState::new(Arc::clone(&supervisor)));
            app.manage(remote);
            app.manage(Arc::new(PluginJobs::default()));
            app.manage(Arc::new(PluginIntents::default()));
            app.manage(Arc::new(NodeJobs::default()));
            app.manage(Arc::new(sessions::Library::default()));
            app.manage(recovery::RendererHealth::default());
            app.manage(terminal::Terminals::new()?);
            // Before `desktop::wire`, which is where a link that started the app
            // is put down for whoever asks for it first.
            app.manage(desktop::Desk::default());

            window::build(app.handle())?;
            application_menu::build(app.handle())?;
            tray::build(app.handle())?;
            desktop::wire(app.handle());
            sessions::attention::wire(app.handle());
            // After the tray, which is the only way back to a window this may
            // decide to leave hidden.
            startup::wire(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            harness::commands::harness_environment,
            harness::commands::harness_status,
            harness::commands::harness_start,
            harness::commands::harness_stop,
            harness::commands::harness_install,
            harness::commands::harness_log,
            node::commands::node_provision,
            node::commands::node_select,
            remote::commands::remote_status,
            remote::commands::remote_open,
            remote::commands::remote_close,
            remote::commands::remote_renew,
            remote::commands::remote_forget,
            plugins::commands::plugin_state,
            plugins::commands::plugin_recovery_notice,
            plugins::commands::plugin_recovery_acknowledge,
            plugins::commands::plugin_recovery_retry,
            plugins::commands::plugin_search,
            plugins::commands::plugin_detail,
            plugins::commands::plugin_media,
            plugins::commands::plugin_preview,
            plugins::commands::plugin_sources,
            plugins::commands::plugin_source_health,
            plugins::commands::plugin_source_select,
            plugins::commands::plugin_source_add,
            plugins::commands::plugin_source_remove,
            plugins::commands::plugin_add,
            plugins::commands::plugin_remove,
            plugins::commands::plugin_switch,
            plugins::commands::plugin_archive,
            plugins::commands::plugin_import,
            presets::preset_roster,
            presets::preset_choose,
            profiles::commands::profile_roster,
            profiles::commands::profile_recovery_notice,
            profiles::commands::profile_recovery_acknowledge,
            profiles::commands::profile_recovery_disable_plugin,
            profiles::commands::profile_recovery_retry,
            profiles::commands::profile_select,
            profiles::commands::profile_create,
            profiles::commands::profile_duplicate,
            profiles::commands::profile_rename,
            profiles::commands::profile_remove,
            profiles::commands::profile_compare,
            profiles::commands::profile_export,
            profiles::commands::profile_declaration,
            profiles::commands::profile_import,
            terminal::commands::terminal_open,
            terminal::commands::terminal_write,
            terminal::commands::terminal_resize,
            terminal::commands::terminal_close,
            terminal::commands::terminal_list,
            sessions::commands::session_roster,
            sessions::commands::session_search,
            sessions::commands::session_read,
            sessions::commands::session_export,
            sessions::commands::session_save,
            startup::startup_state,
            startup::startup_autostart,
            startup::startup_shortcut,
            startup::startup_notification,
            startup::startup_notification_test,
            startup::startup_log_level,
            startup::startup_harness_port,
            material::window_material,
            window::window_open,
            desktop::commands::desktop_offer,
            desktop::commands::desktop_notify,
            desktop::commands::desktop_attention,
            desktop::commands::desktop_badge,
            about::app_about,
            diagnostics::report_build,
            diagnostics::report_save,
            diagnostics::report_archive,
            diagnostics::report_frontend_crash,
            recovery::renderer_ready,
            recovery::recovery_state,
            recovery::recovery_retry,
            recovery::recovery_export_diagnostics,
            recovery::recovery_quit,
            workspace::workspace_select,
            workspace::workspace_inspect,
        ])
        .run(tauri::generate_context!())
        .expect("dsh-studio failed to start");
}

/// Export bounded, redacted evidence without starting Tauri, Harness or a window.
pub fn export_diagnostics_cli() -> std::result::Result<std::path::PathBuf, String> {
    logging::install_panic_hook();
    diagnostics::export_headless(env!("CARGO_PKG_VERSION")).map_err(|cause| cause.to_string())
}

/// Relay supervisor events to the frontend for as long as the app is running.
///
/// Also the one place the tray learns anything: it reads the same stream the UI
/// does, so the two cannot end up describing different states.
fn forward_events(app: &tauri::AppHandle, supervisor: &Arc<Supervisor>, remote: &Arc<Remote>) {
    let handle = app.clone();
    let remote = Arc::clone(remote);
    let mut events = supervisor.subscribe();

    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    if let Event::Status(status) = &event {
                        tray::sync(&handle, status);
                        // A door onto a service that is no longer serving is a
                        // door onto nothing. It closes with the service rather
                        // than waiting for someone to notice.
                        if !matches!(status, Status::Ready { .. }) {
                            remote.close();
                        }
                    }
                    let _ = handle.emit(EVENT_CHANNEL, event);
                }
                // A slow frontend drops old log lines rather than stalling the
                // supervisor. Status is re-sent on every change, so the UI still
                // converges on the truth.
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// Tell the remote panel when a connection opens or closes.
///
/// The signal carries nothing — the panel asks for the numbers itself — so a
/// dropped or coalesced notification costs a redraw, never a wrong count.
fn forward_remote_changes(app: &tauri::AppHandle, remote: &Arc<Remote>) {
    let handle = app.clone();
    let mut changes = remote.subscribe();

    tauri::async_runtime::spawn(async move {
        while let Ok(()) | Err(RecvError::Lagged(_)) = changes.recv().await {
            let _ = handle.emit(REMOTE_CHANNEL, ());
        }
    });
}

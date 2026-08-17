//! dsh-studio — a native desktop shell for the DeepSeek Harness.

mod about;
mod error;
mod fetch;
mod harness;
mod locale;
mod material;
mod node;
mod paths;
mod plugins;
mod remote;
mod tray;
mod window;

use std::sync::Arc;

use tauri::{Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;

use harness::commands::AppState;
use harness::supervisor::{Event, Status, Supervisor};
use node::NodeJobs;
use plugins::PluginJobs;
use remote::Remote;

/// Channel the frontend listens on for supervisor status and log events.
const EVENT_CHANNEL: &str = "harness://event";

/// Channel the remote panel listens on for connection counts.
const REMOTE_CHANNEL: &str = "remote://changed";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch surfaces the running app instead of starting
            // another harness — two would fight over the same session store.
            if let Some(existing) = app.get_webview_window(window::MAIN_LABEL) {
                window::reveal(&existing);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let supervisor = Supervisor::new()?;
            let remote = Arc::new(Remote::new());

            forward_events(app.handle(), &supervisor, &remote);
            forward_remote_changes(app.handle(), &remote);

            app.manage(AppState::new(Arc::clone(&supervisor)));
            app.manage(remote);
            app.manage(Arc::new(PluginJobs::default()));
            app.manage(Arc::new(NodeJobs::default()));

            window::build(app.handle())?;
            tray::build(app.handle())?;
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
            remote::commands::remote_status,
            remote::commands::remote_open,
            remote::commands::remote_close,
            remote::commands::remote_renew,
            remote::commands::remote_forget,
            plugins::commands::plugin_state,
            plugins::commands::plugin_search,
            plugins::commands::plugin_detail,
            plugins::commands::plugin_add,
            plugins::commands::plugin_remove,
            plugins::commands::plugin_switch,
            material::window_material,
            about::app_about,
        ])
        .run(tauri::generate_context!())
        .expect("dsh-studio failed to start");
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

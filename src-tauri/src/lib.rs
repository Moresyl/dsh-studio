//! dsh-studio — a native desktop shell for the DeepSeek Harness.

mod error;
mod harness;
mod paths;
mod window;

use std::sync::Arc;

use tauri::{Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;

use harness::commands::AppState;
use harness::supervisor::Supervisor;

/// Channel the frontend listens on for supervisor status and log events.
const EVENT_CHANNEL: &str = "harness://event";

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
        .setup(|app| {
            let supervisor = Supervisor::new()?;
            forward_events(app.handle(), &supervisor);
            app.manage(AppState::new(Arc::clone(&supervisor)));

            window::build(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            harness::commands::harness_environment,
            harness::commands::harness_status,
            harness::commands::harness_start,
            harness::commands::harness_stop,
            harness::commands::harness_install,
            harness::commands::harness_log,
        ])
        .run(tauri::generate_context!())
        .expect("dsh-studio failed to start");
}

/// Relay supervisor events to the frontend for as long as the app is running.
fn forward_events(app: &tauri::AppHandle, supervisor: &Arc<Supervisor>) {
    let handle = app.clone();
    let mut events = supervisor.subscribe();

    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
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

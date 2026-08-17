//! The IPC surface for installing a Node runtime.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use node_runtime::NodeInstallation;
use tauri::{AppHandle, Emitter, State};

use super::{provision, NodeJobs, Progress};
use crate::error::{Error, Result};
use crate::harness::commands::AppState;
use crate::harness::supervisor::Stream;

/// Channel the frontend listens on while a runtime is being installed.
pub const PROGRESS_CHANNEL: &str = "node://progress";

/// Download and install a Node runtime, reporting progress as it goes.
///
/// Resolves once the runtime answers `--version`, so a caller that re-reads the
/// environment afterwards is guaranteed to see it.
#[tauri::command]
pub async fn node_provision(
    app: AppHandle,
    jobs: State<'_, Arc<NodeJobs>>,
    state: State<'_, AppState>,
) -> Result<NodeInstallation> {
    if jobs.busy.swap(true, Ordering::SeqCst) {
        return Err(Error::NodeProvisionBusy);
    }

    let report = {
        let app = app.clone();
        let supervisor = Arc::clone(&state.supervisor);
        move |progress: Progress| {
            // Two audiences. The event drives the progress card, which is gone
            // the moment this finishes; the log is what is still there afterwards
            // when someone asks where their Node came from.
            if let Some(line) = progress.note() {
                supervisor.note(Stream::Stdout, line);
            }
            let _ = app.emit(PROGRESS_CHANNEL, &progress);
        }
    };

    let outcome = provision(report).await;
    jobs.busy.store(false, Ordering::SeqCst);

    // Same treatment the harness install gets: a failure is said out loud in the
    // log as well as returned, because the log is where the lines leading up to
    // it are.
    if let Err(failure) = &outcome {
        state.supervisor.note(Stream::Stderr, failure.to_string());
    }
    outcome
}

//! The three things the remote panel can ask for.

use std::sync::Arc;

use tauri::State;

use super::{Remote, RemoteStatus};
use crate::error::{Error, Result};
use crate::harness::commands::AppState;
use crate::harness::supervisor::{Status, Stream};

#[tauri::command]
pub fn remote_status(remote: State<'_, Arc<Remote>>) -> RemoteStatus {
    remote.status()
}

/// Open the door, and say so in the log.
///
/// The log line carries the address but not the secret. Anything written to a
/// log outlives the session it belonged to, and the whole point of a per-session
/// secret is that nothing does.
#[tauri::command]
pub async fn remote_open(
    state: State<'_, AppState>,
    remote: State<'_, Arc<Remote>>,
) -> Result<RemoteStatus> {
    let Status::Ready { origin, .. } = state.supervisor.status() else {
        return Err(Error::RemoteNeedsHarness);
    };

    let status = remote.open(&origin).await?;
    if let Some(url) = &status.url {
        state
            .supervisor
            .note(Stream::Stdout, format!("remote access open at {url}"));
    }
    Ok(status)
}

#[tauri::command]
pub fn remote_close(state: State<'_, AppState>, remote: State<'_, Arc<Remote>>) -> RemoteStatus {
    if remote.is_open() {
        state
            .supervisor
            .note(Stream::Stdout, "remote access closed".to_string());
    }
    remote.close();
    remote.status()
}

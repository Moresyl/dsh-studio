//! The five things the remote panel can ask for.

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
/// The log line carries the address but no credential. Anything written to a
/// log outlives the session it belonged to, and the whole point of a secret that
/// only exists while the door is open is that nothing does.
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

/// Put a new pairing code on screen after the last one ran out.
///
/// Nothing is logged: a code being replaced is not an event about the machine,
/// and the log is read while sharing a screen at least as often as the pane is.
#[tauri::command]
pub fn remote_renew(remote: State<'_, Arc<Remote>>) -> Result<RemoteStatus> {
    remote.renew()
}

/// Forget one paired device.
///
/// This one is logged, because it is the answer to "did that phone really lose
/// access?" — and the id is a handle, not a secret.
#[tauri::command]
pub fn remote_forget(
    id: String,
    state: State<'_, AppState>,
    remote: State<'_, Arc<Remote>>,
) -> RemoteStatus {
    let status = remote.forget(&id);
    state
        .supervisor
        .note(Stream::Stdout, format!("remote device {id} forgotten"));
    status
}

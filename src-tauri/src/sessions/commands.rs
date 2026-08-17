//! The three calls the history is asked for.
//!
//! Every one of them runs on a blocking thread rather than on the async runtime.
//! A first look at a machine with a year of history reads and decompresses every
//! log on the disk, and doing that on a runtime worker would stall every other
//! thing the app is waiting on — the harness starting, a plugin installing, a
//! terminal drawing — for as long as it took.

use std::sync::Arc;

use tauri::State;

use crate::error::{Error, Result};

use super::{find::Hit, Library, Shelved, Transcript};

#[tauri::command]
pub async fn session_roster(library: State<'_, Arc<Library>>) -> Result<Shelved> {
    let library = Arc::clone(&library);
    away(move || library.roster()).await
}

#[tauri::command]
pub async fn session_search(
    library: State<'_, Arc<Library>>,
    query: String,
    project: Option<String>,
) -> Result<Vec<Hit>> {
    let library = Arc::clone(&library);
    away(move || library.search(&query, project.as_deref())).await
}

#[tauri::command]
pub async fn session_read(library: State<'_, Arc<Library>>, id: String) -> Result<Transcript> {
    let library = Arc::clone(&library);
    let found = away(move || library.transcript(&id)).await?;

    // A session can be deleted between being listed and being opened, and the
    // list is a snapshot either way.
    found.ok_or_else(|| Error::Session("that session is no longer on disk".into()))
}

/// Run the work off the runtime and answer with what it found.
async fn away<T, W>(work: W) -> Result<T>
where
    T: Send + 'static,
    W: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|cause| Error::Session(format!("reading the session history failed: {cause}")))
}

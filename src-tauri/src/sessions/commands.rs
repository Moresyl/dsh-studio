//! The calls the history is asked for.
//!
//! Every one of them runs on a blocking thread rather than on the async runtime.
//! A first look at a machine with a year of history reads and decompresses every
//! log on the disk, and doing that on a runtime worker would stall every other
//! thing the app is waiting on — the harness starting, a plugin installing, a
//! terminal drawing — for as long as it took.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};

use super::export::{self, Format};
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
    open(library, id).await
}

/// A rendered session, and what to call the file it should go in.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    /// The filename to offer, which the save dialog may well have overridden.
    pub name: String,
    pub text: String,
}

/// Write a session out, without deciding yet where it goes.
///
/// The text comes back rather than being written because there are two things
/// to do with it and only one of them is a file: pasting a conversation into an
/// issue is the other, and it is the more common one.
#[tauri::command]
pub async fn session_export(
    library: State<'_, Arc<Library>>,
    id: String,
    format: Format,
) -> Result<Exported> {
    let transcript = open(library, id).await?;

    Ok(Exported {
        name: export::suggest(&transcript.card, format),
        text: export::render(&transcript, format),
    })
}

/// The same document, put where the user pointed.
///
/// Rust does the writing rather than the webview because the shell holds no
/// filesystem permission at all — the only path it can name is the one the
/// system's own save dialog just returned. It takes the text rather than
/// rendering a second time: this is the document the dialog was named after,
/// and reading a year-long session back off the disk to rebuild a string that
/// is already in hand would be work nobody asked for.
#[tauri::command]
pub async fn session_save(path: String, text: String) -> Result<()> {
    tokio::task::spawn_blocking(move || crate::atomic::write(std::path::Path::new(&path), text))
        .await
        .map_err(|cause| Error::Session(format!("writing the session failed: {cause}")))?
        .map_err(|cause| Error::Session(format!("writing the session failed: {cause}")))
}

/// One session, read off the disk, or the sentence saying it is not there.
async fn open(library: State<'_, Arc<Library>>, id: String) -> Result<Transcript> {
    let library = Arc::clone(&library);
    let found = away(move || library.transcript(&id)).await?;

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

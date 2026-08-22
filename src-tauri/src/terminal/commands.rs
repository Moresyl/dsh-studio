//! The terminal's command surface.
//!
//! Thin on purpose: everything interesting is in [`Terminals`], and these exist
//! only to name it from the frontend.

use std::sync::Arc;

use tauri::{AppHandle, State};

use super::{Session, Terminals};
use crate::error::Result;

#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    terminals: State<'_, Arc<Terminals>>,
    rows: u16,
    cols: u16,
) -> Result<Session> {
    // A packaged macOS app does not inherit the PATH an interactive shell has.
    // Resolve the same bounded, credential-filtered login environment used by
    // the Harness before the PTY starts, so zsh startup commands and user tools
    // such as starship or claude are reachable from the first prompt.
    let shell = crate::harness::shell_environment::resolve().await;
    terminals.open(&app, rows, cols, &shell.updates)
}

#[tauri::command]
pub async fn terminal_write(
    terminals: State<'_, Arc<Terminals>>,
    id: String,
    data: String,
) -> Result<()> {
    terminals.write(&id, &data)
}

#[tauri::command]
pub async fn terminal_resize(
    terminals: State<'_, Arc<Terminals>>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<()> {
    terminals.resize(&id, rows, cols)
}

#[tauri::command]
pub async fn terminal_close(terminals: State<'_, Arc<Terminals>>, id: String) -> Result<()> {
    terminals.close(&id)
}

/// Terminals that are still open.
///
/// Answers the question a reopened pane has to ask: the tab strip lives in the
/// frontend's own state, and this is what tells it which of those tabs still has
/// a shell behind it.
#[tauri::command]
pub async fn terminal_list(terminals: State<'_, Arc<Terminals>>) -> Result<Vec<Session>> {
    Ok(terminals.list())
}

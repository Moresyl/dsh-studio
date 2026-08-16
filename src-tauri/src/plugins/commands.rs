//! The IPC surface behind the plugin panel.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::State;

use super::registry::{Detail, Listing};
use super::{Change, PluginJobs, PluginState};
use crate::error::{Error, Result};
use crate::harness::commands::AppState;
use crate::harness::supervisor::Stream;

#[tauri::command]
pub fn plugin_state() -> PluginState {
    super::state()
}

#[tauri::command]
pub async fn plugin_search(query: String) -> Result<Vec<Listing>> {
    super::registry::search(&node()?, &query).await
}

#[tauri::command]
pub async fn plugin_detail(name: String) -> Result<Detail> {
    super::registry::detail(&node()?, &name).await
}

/// Install a plugin into the hosted profile.
///
/// Returns the profile as it is afterwards, so the panel redraws from what is
/// on disk rather than from what it hoped the install would do.
#[tauri::command]
pub async fn plugin_add(
    spec: String,
    state: State<'_, AppState>,
    jobs: State<'_, Arc<PluginJobs>>,
) -> Result<PluginState> {
    apply(Change::Add, &spec, &state, &jobs).await
}

#[tauri::command]
pub async fn plugin_remove(
    name: String,
    state: State<'_, AppState>,
    jobs: State<'_, Arc<PluginJobs>>,
) -> Result<PluginState> {
    apply(Change::Remove, &name, &state, &jobs).await
}

async fn apply(
    change: Change,
    spec: &str,
    state: &State<'_, AppState>,
    jobs: &State<'_, Arc<PluginJobs>>,
) -> Result<PluginState> {
    if jobs.busy.swap(true, Ordering::SeqCst) {
        return Err(Error::PluginBusy);
    }

    let supervisor = Arc::clone(&state.supervisor);
    let reporter = Arc::clone(&supervisor);
    let outcome = super::change(change, spec, supervisor.guard(), move |stream, line| {
        reporter.note(stream, line)
    })
    .await;
    jobs.busy.store(false, Ordering::SeqCst);

    match &outcome {
        // The layer stack is composed at boot, so a change is on disk now and in
        // effect at the next start. Saying so here is cheaper than letting
        // someone wonder why nothing happened.
        Ok(()) => supervisor.note(
            Stream::Stdout,
            format!("{spec} written to the profile; restart the harness to apply it"),
        ),
        Err(failure) => supervisor.note(Stream::Stderr, failure.to_string()),
    }
    outcome.map(|()| super::state())
}

/// The Node runtime every registry call runs through.
fn node() -> Result<PathBuf> {
    crate::harness::environment()
        .node
        .map(|installation| installation.path)
        .ok_or(Error::NoNodeRuntime {
            minimum: node_runtime::MINIMUM_SUPPORTED,
        })
}

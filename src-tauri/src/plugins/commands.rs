//! The IPC surface behind the plugin panel.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::State;

use super::archive::Package;
use super::registry::{Detail, Listing};
use super::{Change, PluginJobs, PluginState};
use crate::error::{Error, Result};
use crate::harness::commands::AppState;
use crate::harness::supervisor::{Stream, Supervisor};

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

/// Read a plugin archive on this machine without installing anything from it.
///
/// Its own command rather than the first half of the import, because a file is
/// not a search result: the only thing anybody knows about the one they just
/// picked is what it is called on disk. So the panel reads the manifest out of
/// it and puts the package's own name, version and description in front of the
/// user before a package manager is allowed anywhere near the profile.
#[tauri::command]
pub async fn plugin_archive(path: String) -> Result<Package> {
    // Off the runtime: this decompresses a file of unknown size, and the async
    // workers are what the harness's own output is being read on.
    tokio::task::spawn_blocking(move || super::archive::read(Path::new(&path)))
        .await
        .map_err(|cause| Error::Plugin(format!("reading the archive failed: {cause}")))?
}

/// Install a plugin from an archive the user picked.
#[tauri::command]
pub async fn plugin_import(
    path: String,
    state: State<'_, AppState>,
    jobs: State<'_, Arc<PluginJobs>>,
) -> Result<PluginState> {
    let _busy = Busy::claim(&jobs.busy)?;

    let supervisor = Arc::clone(&state.supervisor);
    let reporter = Arc::clone(&supervisor);
    let outcome = super::import(Path::new(&path), supervisor.guard(), move |stream, line| {
        reporter.note(stream, line)
    })
    .await;

    // Named by the package rather than by the file it came out of: the file name
    // is the user's, and two of them may hold the same package.
    settle(
        &supervisor,
        outcome.map(|package| format!("{} {}", package.name, package.version)),
    )
}

/// Switch an installed plugin on or off, leaving it installed either way.
///
/// Synchronous where installing is not: no package manager runs, so there is
/// nothing to stream and nothing to guard against a second click.
#[tauri::command]
pub fn plugin_switch(
    name: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<PluginState> {
    super::switch(&name, enabled)?;
    state.supervisor.note(
        Stream::Stdout,
        format!(
            "{name} switched {} in the profile; restart the harness to apply it",
            if enabled { "on" } else { "off" }
        ),
    );
    Ok(super::state())
}

async fn apply(
    change: Change,
    spec: &str,
    state: &State<'_, AppState>,
    jobs: &State<'_, Arc<PluginJobs>>,
) -> Result<PluginState> {
    let _busy = Busy::claim(&jobs.busy)?;

    let supervisor = Arc::clone(&state.supervisor);
    let reporter = Arc::clone(&supervisor);
    let outcome = super::change(change, spec, supervisor.guard(), move |stream, line| {
        reporter.note(stream, line)
    })
    .await;

    settle(&supervisor, outcome.map(|()| spec.to_string()))
}

/// Say how a change went, and answer with the profile as it now is.
///
/// Read back off disk rather than assembled from what was asked for: a package
/// manager can succeed at something other than what was typed, and the panel
/// should be drawing the profile that exists.
fn settle(supervisor: &Supervisor, outcome: Result<String>) -> Result<PluginState> {
    match &outcome {
        // The layer stack is composed at boot, so a change is on disk now and in
        // effect at the next start. Saying so here is cheaper than letting
        // someone wonder why nothing happened.
        Ok(subject) => supervisor.note(
            Stream::Stdout,
            format!("{subject} written to the profile; restart the harness to apply it"),
        ),
        Err(failure) => supervisor.note(Stream::Stderr, failure.to_string()),
    }
    outcome.map(|_| super::state())
}

/// The one-change-at-a-time flag, held for as long as the change runs.
///
/// A guard rather than a set and a matching clear, because there are three ways
/// out of a change and only two of them are lines of code: it lands, it fails,
/// or the task is dropped because the window closed. A flag left set by the
/// third is a panel that refuses to install anything again until the whole
/// application is restarted, and nothing on screen would say why.
struct Busy<'a>(&'a AtomicBool);

impl<'a> Busy<'a> {
    fn claim(flag: &'a AtomicBool) -> Result<Self> {
        if flag.swap(true, Ordering::SeqCst) {
            return Err(Error::PluginBusy);
        }
        Ok(Self(flag))
    }
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
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

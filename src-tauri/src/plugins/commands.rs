//! The IPC surface behind the plugin panel.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::State;

use super::archive::Package;
use super::registry::Detail;
use super::{Change, PluginJobs, PluginState};
use crate::error::{Error, Result};
use crate::harness::commands::AppState;
use crate::harness::supervisor::{Stream, Supervisor};

#[tauri::command]
pub fn plugin_state() -> PluginState {
    super::state()
}

/// Result of recovering a package-manager operation interrupted by shutdown.
#[tauri::command]
pub fn plugin_recovery_notice() -> Option<super::recovery::RecoveryNotice> {
    super::recovery::notice()
}

#[tauri::command]
pub fn plugin_recovery_acknowledge() -> Result<()> {
    super::recovery::acknowledge()
}

#[tauri::command]
pub async fn plugin_search(
    query: String,
    category: Option<String>,
    sort: String,
    page: usize,
    refresh: bool,
) -> Result<super::market::Page> {
    let source = super::catalog::sources()
        .into_iter()
        .find(|source| source.active)
        .ok_or_else(|| Error::Plugin("no plugin catalog source is active".into()))?;
    super::market::search(
        &node()?,
        &source.id,
        &query,
        category.as_deref(),
        &sort,
        page,
        refresh,
    )
    .await
}

#[tauri::command]
pub async fn plugin_detail(source_id: String, name: String, version: String) -> Result<Detail> {
    if source_id == "npm" {
        return super::registry::detail(&node()?, &name).await;
    }
    let mut detail = super::registry::preflight(&node()?, &format!("{name}@{version}")).await?;
    detail.source = super::catalog::label(&source_id);
    Ok(detail)
}

#[tauri::command]
pub fn plugin_sources() -> Vec<super::catalog::Source> {
    super::catalog::sources()
}

#[tauri::command]
pub fn plugin_source_select(id: String) -> Result<Vec<super::catalog::Source>> {
    super::catalog::select(&id)
}

#[tauri::command]
pub async fn plugin_source_add(
    label: String,
    endpoint: String,
) -> Result<Vec<super::catalog::Source>> {
    let sources = super::catalog::add(&label, &endpoint).await?;
    if let Some(source) = sources.iter().find(|source| source.active) {
        super::market::invalidate(&source.id).await;
    }
    Ok(sources)
}

#[tauri::command]
pub async fn plugin_source_remove(id: String) -> Result<Vec<super::catalog::Source>> {
    let sources = super::catalog::remove(&id)?;
    super::market::invalidate(&id).await;
    Ok(sources)
}

/// Install a plugin into the hosted profile.
///
/// Returns the profile as it is afterwards, so the panel redraws from what is
/// on disk rather than from what it hoped the install would do.
#[tauri::command]
pub async fn plugin_add(
    spec: String,
    source_id: String,
    item_id: String,
    display_name: String,
    state: State<'_, AppState>,
    jobs: State<'_, Arc<PluginJobs>>,
) -> Result<PluginState> {
    let detail = super::registry::preflight(&node()?, &spec).await?;
    if spec != detail.install_spec {
        return Err(Error::Plugin(format!(
            "market installs require the exact immutable spec {}",
            detail.install_spec
        )));
    }
    let source = super::catalog::sources()
        .into_iter()
        .find(|source| source.id == source_id && source.active)
        .ok_or_else(|| Error::Plugin("the selected catalog source is no longer active".into()))?;
    if item_id != detail.name {
        return Err(Error::Plugin(
            "the selected catalog item does not match the resolved package".into(),
        ));
    }
    if source.id != "npm" {
        let catalogued = super::catalog::search(&source.id, "")
            .await?
            .into_iter()
            .any(|item| {
                item.name == detail.name && item.version == detail.version && item.installable
            });
        if !catalogued {
            return Err(Error::Plugin(
                "the exact package version is no longer present in the selected catalog".into(),
            ));
        }
    }
    let profile = crate::profiles::selected();
    let profile_dir = crate::paths::profile_dir(&profile);
    apply(Change::Add, &spec, &state, &jobs, move || {
        super::receipts::record(
            &profile,
            &profile_dir,
            &source.id,
            &item_id,
            &display_name,
            &detail,
        )
    })
    .await
}

#[tauri::command]
pub async fn plugin_remove(
    name: String,
    state: State<'_, AppState>,
    jobs: State<'_, Arc<PluginJobs>>,
) -> Result<PluginState> {
    let profile = crate::profiles::selected();
    let profile_dir = crate::paths::profile_dir(&profile);
    let receipt_name = name.clone();
    apply(Change::Remove, &name, &state, &jobs, move || {
        super::receipts::remove(&profile, &profile_dir, &receipt_name)
    })
    .await
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

async fn apply<F>(
    change: Change,
    spec: &str,
    state: &State<'_, AppState>,
    jobs: &State<'_, Arc<PluginJobs>>,
    finalize: F,
) -> Result<PluginState>
where
    F: FnOnce() -> Result<()>,
{
    let _busy = Busy::claim(&jobs.busy)?;

    let supervisor = Arc::clone(&state.supervisor);
    let reporter = Arc::clone(&supervisor);
    let outcome = super::change_finalize(
        change,
        spec,
        supervisor.guard(),
        move |stream, line| reporter.note(stream, line),
        finalize,
    )
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

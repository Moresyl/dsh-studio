//! The IPC surface behind the plugin panel.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::archive::Package;
use super::registry::Detail;
use super::{Change, PluginIntents, PluginJobs, PluginState};
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

/// Replay one restored package transaction after the recovery UI has shown its
/// exact target and generation. Success consumes the notice; failure leaves it
/// available for another reviewed attempt.
#[tauri::command]
pub async fn plugin_recovery_retry(
    generation: String,
    state: State<'_, AppState>,
    jobs: State<'_, Arc<PluginJobs>>,
) -> Result<()> {
    let notice = super::recovery::checked_notice(&generation)?;
    if !notice.restored {
        return Err(Error::Plugin(
            "automatic recovery did not complete; export diagnostics and repair the profile manually"
                .into(),
        ));
    }
    let retry = notice.retry.clone().ok_or_else(|| {
        Error::Plugin("this recovered operation cannot be replayed safely".into())
    })?;
    reject_retry_drift(&notice.profile, &retry)?;
    let _busy = jobs.claim()?;
    let supervisor = Arc::clone(&state.supervisor);
    let reporter = Arc::clone(&supervisor);
    let profile = notice.profile.clone();
    let profile_dir = crate::paths::profile_dir(&profile);

    let outcome = match retry.clone() {
        super::recovery::RetryPlan::Add {
            spec,
            source_id,
            item_id,
            display_name,
        } => {
            let (resolved_name, resolved_version) = super::split_spec(&spec);
            let resolved_version = resolved_version.ok_or_else(|| {
                Error::Plugin("the recovered market target is not an exact version".into())
            })?;
            let detail = reviewed_detail(&source_id, resolved_name, resolved_version, true).await?;
            if detail.install_spec != spec || detail.name != item_id {
                return Err(Error::Plugin(
                    "the recovered package no longer resolves to the reviewed immutable version"
                        .into(),
                ));
            }
            verify_dependency_graph(&spec, &state).await?;
            let source = super::catalog::sources()
                .into_iter()
                .find(|source| source.id == source_id && source.active)
                .ok_or_else(|| {
                    Error::Plugin("the recovered catalog source is no longer active".into())
                })?;
            let receipt_profile = profile.clone();
            super::change_profile_finalize(
                &profile,
                Change::Add,
                &spec,
                retry,
                supervisor.guard(),
                move |stream, line| reporter.note(stream, line),
                move || {
                    super::receipts::record(
                        &receipt_profile,
                        &profile_dir,
                        &source.id,
                        &item_id,
                        &display_name,
                        &detail,
                    )
                },
            )
            .await
        }
        super::recovery::RetryPlan::Remove { name } => {
            let receipt_name = name.clone();
            let receipt_profile = profile.clone();
            super::change_profile_finalize(
                &profile,
                Change::Remove,
                &name,
                retry,
                supervisor.guard(),
                move |stream, line| reporter.note(stream, line),
                move || super::receipts::remove(&receipt_profile, &profile_dir, &receipt_name),
            )
            .await
        }
    };
    match outcome {
        Ok(()) => {
            super::recovery::acknowledge()?;
            supervisor.note(
                Stream::Stdout,
                "recovered plugin operation completed".into(),
            );
            Ok(())
        }
        Err(failure) => {
            supervisor.note(Stream::Stderr, failure.to_string());
            Err(failure)
        }
    }
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
    reviewed_detail(&source_id, &name, &version, false).await
}

/// Resolve optional catalog imagery through the native restricted-media path.
/// The renderer supplies identity only; the URL is re-read from the source.
#[tauri::command]
pub async fn plugin_media(
    source_id: String,
    name: String,
    version: String,
) -> Result<Option<super::media::Asset>> {
    if source_id == "npm" {
        return Ok(None);
    }
    let candidate = super::catalog::find(&source_id, &name, &version, None)
        .await?
        .and_then(|item| item.icon);
    let Some(candidate) = candidate else {
        return Ok(None);
    };
    // Optional media never makes a catalog item unusable.
    Ok(super::media::fetch(&candidate).await.ok())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPreview {
    token: String,
    expires_in_seconds: u64,
}

/// Verify the exact registry and catalog identities, then issue one short-lived
/// confirmation bound to the active profile.
#[tauri::command]
pub async fn plugin_preview(
    spec: String,
    source_id: String,
    item_id: String,
    display_name: String,
    state: State<'_, AppState>,
    intents: State<'_, Arc<PluginIntents>>,
) -> Result<InstallPreview> {
    let (name, version) = super::split_spec(&spec);
    let version = version
        .ok_or_else(|| Error::Plugin("market installs require an exact package version".into()))?;
    let detail = reviewed_detail(&source_id, name, version, true).await?;
    if detail.install_spec != spec || detail.name != item_id {
        return Err(Error::Plugin(
            "the selected catalog item does not match the exact registry package".into(),
        ));
    }
    verify_dependency_graph(&spec, &state).await?;
    let token = intents.issue(
        crate::profiles::selected(),
        spec,
        source_id,
        item_id,
        display_name,
    )?;
    Ok(InstallPreview {
        token,
        expires_in_seconds: super::INTENT_TTL.as_secs(),
    })
}

#[tauri::command]
pub fn plugin_sources() -> Vec<super::catalog::Source> {
    super::catalog::sources()
}

/// Re-read one source through the same bounded parser used by the market.
/// npm is an authority rather than a catalog document, so its probe resolves
/// the pinned Harness package through the user's configured registry instead.
#[tauri::command]
pub async fn plugin_source_health(id: String) -> Result<super::catalog::Health> {
    if id != "npm" {
        return super::catalog::health(&id).await;
    }
    let started = std::time::Instant::now();
    let detail = super::registry::detail(&node()?, crate::harness::install::PACKAGE).await?;
    let listing = super::registry::Listing {
        name: detail.name,
        version: detail.version,
        description: detail.description,
        publisher: String::new(),
        updated: String::new(),
        weekly_downloads: 0,
        link: detail.homepage.clone().or(detail.repository.clone()),
        repository: detail.repository,
        source_id: "npm".into(),
        source_label: "npm registry".into(),
        installable: true,
        categories: Vec::new(),
        has_icon: false,
        icon: None,
    };
    Ok(super::catalog::Health::from_listings(
        "npm",
        "npm/package-metadata-v1",
        &[listing],
        started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
    ))
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
    token: String,
    state: State<'_, AppState>,
    jobs: State<'_, Arc<PluginJobs>>,
    intents: State<'_, Arc<PluginIntents>>,
) -> Result<PluginState> {
    let profile = crate::profiles::selected();
    // Registry and catalog checks can fail for transient reasons. Inspect the
    // one-shot confirmation first, then spend it only after those checks and
    // the cross-window job claim succeed.
    let intent = intents.inspect(&token, &profile)?;
    let spec = intent.spec.clone();
    let source_id = intent.source_id.clone();
    let item_id = intent.item_id.clone();
    let display_name = intent.display_name.clone();
    let (resolved_name, resolved_version) = super::split_spec(&spec);
    let resolved_version = resolved_version
        .ok_or_else(|| Error::Plugin("market installs require an exact package version".into()))?;
    let detail = reviewed_detail(&source_id, resolved_name, resolved_version, true).await?;
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
    verify_dependency_graph(&spec, &state).await?;
    let profile_dir = crate::paths::profile_dir(&profile);
    let retry = super::recovery::RetryPlan::Add {
        spec: spec.clone(),
        source_id: source.id.clone(),
        item_id: item_id.clone(),
        display_name: display_name.clone(),
    };
    let _busy = jobs.claim()?;
    // Re-check expiry/profile under the same mutex and atomically remove the
    // token. Nothing before this point changes the profile.
    intents.consume(&token, &profile)?;
    apply_claimed(Change::Add, &spec, retry, &state, move || {
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
    let retry = super::recovery::RetryPlan::Remove { name: name.clone() };
    apply(Change::Remove, &name, retry, &state, &jobs, move || {
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
    let _busy = jobs.claim()?;

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
    retry: super::recovery::RetryPlan,
    state: &State<'_, AppState>,
    jobs: &State<'_, Arc<PluginJobs>>,
    finalize: F,
) -> Result<PluginState>
where
    F: FnOnce() -> Result<()>,
{
    let _busy = jobs.claim()?;

    apply_claimed(change, spec, retry, state, finalize).await
}

/// Apply a change after the caller has claimed the one profile-wide job slot.
async fn apply_claimed<F>(
    change: Change,
    spec: &str,
    retry: super::recovery::RetryPlan,
    state: &State<'_, AppState>,
    finalize: F,
) -> Result<PluginState>
where
    F: FnOnce() -> Result<()>,
{
    let supervisor = Arc::clone(&state.supervisor);
    let reporter = Arc::clone(&supervisor);
    let outcome = super::change_finalize(
        change,
        spec,
        retry,
        supervisor.guard(),
        move |stream, line| reporter.note(stream, line),
        finalize,
    )
    .await;

    settle(&supervisor, outcome.map(|()| spec.to_string()))
}

fn reject_retry_drift(profile: &str, retry: &super::recovery::RetryPlan) -> Result<()> {
    let dependencies = super::read_manifest(&crate::paths::profile_dir(profile))
        .and_then(|manifest| manifest.get("dependencies").cloned())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let (name, matches) = retry_matches(&dependencies, retry);
    if !matches {
        return Err(Error::Plugin(format!(
            "profile {profile} changed after recovery; review {name} manually before retrying"
        )));
    }
    Ok(())
}

fn retry_matches<'a>(
    dependencies: &serde_json::Map<String, serde_json::Value>,
    retry: &'a super::recovery::RetryPlan,
) -> (&'a str, bool) {
    let (name, should_exist) = match retry {
        super::recovery::RetryPlan::Add { spec, .. } => (super::split_spec(spec).0, false),
        super::recovery::RetryPlan::Remove { name } => (name.as_str(), true),
    };
    (name, dependencies.contains_key(name) == should_exist)
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

/// Run the isolated pnpm resolution with the same process guard and log stream
/// as the eventual profile operation.
async fn verify_dependency_graph(spec: &str, state: &State<'_, AppState>) -> Result<()> {
    let supervisor = Arc::clone(&state.supervisor);
    let reporter = Arc::clone(&supervisor);
    super::verify_installable(spec, supervisor.guard(), move |stream, line| {
        reporter.note(stream, line)
    })
    .await
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

async fn reviewed_detail(
    source_id: &str,
    name: &str,
    version: &str,
    enforce: bool,
) -> Result<Detail> {
    let spec = format!("{name}@{version}");
    let mut detail = if enforce {
        super::registry::preflight(&node()?, &spec).await?
    } else if source_id == "npm" && version == "latest" {
        super::registry::detail(&node()?, name).await?
    } else {
        super::registry::resolve(&node()?, &spec).await?
    };
    if source_id == "npm" {
        // npm is the authority being compared with itself; no third-party
        // catalog repository assertion exists in this view.
        detail.repository_verified = true;
        return Ok(detail);
    }
    let source = super::catalog::sources()
        .into_iter()
        .find(|source| source.id == source_id && source.active)
        .ok_or_else(|| Error::Plugin("the selected catalog source is no longer active".into()))?;
    detail.source = source.label;
    let item = super::catalog::find(
        source_id,
        &detail.name,
        &detail.version,
        detail.repository.as_deref(),
    )
    .await?
    .ok_or_else(|| {
        Error::Plugin(
            "the exact package version is no longer present in the selected catalog".into(),
        )
    })?;
    detail.repository_verified = item
        .repository
        .as_deref()
        .and_then(super::registry::repository_identity)
        .zip(
            detail
                .repository
                .as_deref()
                .and_then(super::registry::repository_identity),
        )
        .is_some_and(|(catalog, registry)| catalog == registry);
    if enforce && !detail.repository_verified {
        return Err(Error::Plugin(
            "the npm package repository did not match the selected catalog".into(),
        ));
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value};

    use super::super::recovery::RetryPlan;

    #[test]
    fn retries_only_the_before_image_the_preview_described() {
        let mut dependencies = Map::new();
        dependencies.insert("plugin-a".into(), Value::String("1.0.0".into()));
        let remove = RetryPlan::Remove {
            name: "plugin-a".into(),
        };
        let add = RetryPlan::Add {
            spec: "plugin-b@2.0.0".into(),
            source_id: "npm".into(),
            item_id: "plugin-b".into(),
            display_name: "Plugin B".into(),
        };

        assert!(super::retry_matches(&dependencies, &remove).1);
        assert!(super::retry_matches(&dependencies, &add).1);
        dependencies.remove("plugin-a");
        dependencies.insert("plugin-b".into(), Value::String("2.0.0".into()));
        assert!(!super::retry_matches(&dependencies, &remove).1);
        assert!(!super::retry_matches(&dependencies, &add).1);
    }
}

//! The IPC surface behind the profile switcher and the profile manager.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::{Comparison, Declaration, Roster};
use crate::error::{Error, Result};
use crate::harness::commands::AppState;
use crate::harness::supervisor::{Status, Stream};
use crate::paths;
use crate::plugins::{self, switches, PluginJobs};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupRecovery {
    generation: String,
    failed_profile: String,
    recovered_profile: Option<String>,
    reason: String,
    plugins: Vec<String>,
}

#[tauri::command]
pub fn profile_roster() -> Roster {
    super::roster()
}

/// Latest failed profile startup, with only plugins that are safe to disable.
#[tauri::command]
pub fn profile_recovery_notice() -> Option<StartupRecovery> {
    let notice = super::recovery_notice()?;
    let directory = paths::profile_dir(&notice.failed_profile);
    let switched_off = switches::switched_off(&notice.failed_profile);
    let plugins = plugins::read_manifest(&directory)
        .map(|manifest| plugins::list(&manifest, &switched_off))
        .unwrap_or_default()
        .into_iter()
        .filter(|plugin| !plugin.builtin && plugin.active && !plugin.disabled)
        .map(|plugin| plugin.name)
        .collect();
    Some(StartupRecovery {
        generation: notice.generation,
        failed_profile: notice.failed_profile,
        recovered_profile: notice.recovered_profile,
        reason: notice.reason,
        plugins,
    })
}

#[tauri::command]
pub fn profile_recovery_acknowledge() -> Result<()> {
    super::recovery_acknowledge()
}

/// Disable one package in the failed profile without selecting or booting it.
#[tauri::command]
pub fn profile_recovery_disable_plugin(
    name: String,
    generation: String,
) -> Result<StartupRecovery> {
    let notice = super::recovery_notice()
        .ok_or_else(|| Error::Profile("there is no profile startup recovery to change".into()))?;
    checked_generation(&notice.generation, &generation)?;
    let directory = paths::profile_dir(&notice.failed_profile);
    let switched_off = switches::switched_off(&notice.failed_profile);
    let eligible = plugins::read_manifest(&directory)
        .map(|manifest| plugins::list(&manifest, &switched_off))
        .unwrap_or_default()
        .into_iter()
        .any(|plugin| plugin.name == name && !plugin.builtin && plugin.active && !plugin.disabled);
    if !eligible {
        return Err(Error::Profile(format!(
            "{name} is not an active third-party plugin in {}",
            notice.failed_profile
        )));
    }
    switches::set(&notice.failed_profile, &name, false, &directory)?;
    profile_recovery_notice()
        .ok_or_else(|| Error::Profile("the startup recovery record disappeared".into()))
}

/// Re-select the failed profile after the recovery preview. Harness startup is
/// a separate frontend action so the existing supervisor remains the sole
/// owner of process lifecycle and readiness checks.
#[tauri::command]
pub fn profile_recovery_retry(generation: String) -> Result<Roster> {
    let notice = super::recovery_notice()
        .ok_or_else(|| Error::Profile("there is no profile startup recovery to retry".into()))?;
    checked_generation(&notice.generation, &generation)?;
    super::select(&notice.failed_profile)?;
    Ok(super::roster())
}

fn checked_generation(current: &str, offered: &str) -> Result<()> {
    if current.is_empty() || current != offered {
        return Err(Error::Profile(
            "the profile recovery preview is stale; review the current state again".into(),
        ));
    }
    Ok(())
}

/// Point this window at another profile.
///
/// Records the choice and says what it takes to see it. The restart is not done
/// here: a running harness has sessions in it, and ending them is the user's
/// call to make in the window, not a side effect of a menu click.
#[tauri::command]
pub fn profile_select(name: String, state: State<'_, AppState>) -> Result<Roster> {
    super::select(&name)?;
    state.supervisor.note(
        Stream::Stdout,
        format!("profile {name} selected; restart the harness to run it"),
    );
    Ok(super::roster())
}

/// Make a profile with the interface in it and nothing else.
///
/// Synchronous, and that is the point of taking the bundle list from the profile
/// the harness already wrote: the new profile depends on nothing that is not
/// already on the machine, so there is nothing to download and nothing to wait
/// for.
#[tauri::command]
pub fn profile_create(name: String) -> Result<Roster> {
    super::create(&name)?;
    Ok(super::roster())
}

/// Copy a profile, plugins and all.
#[tauri::command]
pub async fn profile_duplicate(
    source: String,
    name: String,
    state: State<'_, AppState>,
    jobs: State<'_, Arc<PluginJobs>>,
) -> Result<Roster> {
    // The market's own guard, because this is the market's own work: a package
    // manager, running over a profile directory.
    let _busy = jobs.claim()?;
    let outcome = match super::duplicate(&source, &name) {
        Ok(specs) => install_into(&name, specs, &state).await,
        Err(failure) => Err(failure),
    };
    outcome.map(|()| super::roster())
}

#[tauri::command]
pub fn profile_rename(from: String, to: String, state: State<'_, AppState>) -> Result<Roster> {
    idle(&from, &state)?;
    super::rename(&from, &to)?;
    Ok(super::roster())
}

#[tauri::command]
pub fn profile_remove(name: String, state: State<'_, AppState>) -> Result<Roster> {
    idle(&name, &state)?;
    super::remove(&name)?;
    Ok(super::roster())
}

#[tauri::command]
pub fn profile_compare(left: String, right: String) -> Result<Comparison> {
    super::compare(&left, &right)
}

/// Write a profile out as a file, at a path the user picked.
#[tauri::command]
pub fn profile_export(name: String, path: PathBuf) -> Result<()> {
    super::save(&super::export(&name)?, &path)
}

/// Read an exported profile so the manager can show what is in it.
#[tauri::command]
pub fn profile_declaration(path: PathBuf) -> Result<Declaration> {
    super::declaration(&path)
}

/// Make a profile from an exported one.
#[tauri::command]
pub async fn profile_import(
    path: PathBuf,
    name: String,
    state: State<'_, AppState>,
    jobs: State<'_, Arc<PluginJobs>>,
) -> Result<Roster> {
    let _busy = jobs.claim()?;
    let outcome = match super::declaration(&path).and_then(|file| super::import(&file, &name)) {
        Ok(specs) => install_into(&name, specs, &state).await,
        Err(failure) => Err(failure),
    };
    outcome.map(|()| super::roster())
}

/// Install what a new profile was written to have.
///
/// Through the harness's own plugin command, so the layer list ends up assembled
/// by the thing that owns the rule for assembling it. A profile with nothing to
/// install skips it entirely: the bundles it came with resolve out of the
/// harness's own dependency closure, so there is no download to make.
///
/// A failure takes the profile with it. What is left otherwise is a profile that
/// looks like the one that was asked for and is missing everything that made it
/// worth copying.
async fn install_into(name: &str, specs: Vec<String>, state: &State<'_, AppState>) -> Result<()> {
    if specs.is_empty() {
        return Ok(());
    }

    let supervisor = Arc::clone(&state.supervisor);
    supervisor.note(
        Stream::Stdout,
        format!(
            "installing {} plugin{} into profile {name}",
            specs.len(),
            if specs.len() == 1 { "" } else { "s" }
        ),
    );

    let mut args = Vec::with_capacity(specs.len() + 1);
    args.push("add".to_string());
    args.extend(specs);

    let reporter = Arc::clone(&supervisor);
    let outcome = plugins::run(name, &args, supervisor.guard(), move |stream, line| {
        reporter.note(stream, line)
    })
    .await;

    match outcome {
        // The harness has just built the layer list from what it installed, which
        // knows nothing about what the original had switched off.
        Ok(()) => switches::apply(name, &paths::profile_dir(name)),
        Err(failure) => {
            supervisor.note(Stream::Stderr, failure.to_string());
            super::discard(name)?;
            Err(failure)
        }
    }
}

/// Refuse to move or delete a profile out from under a running harness.
///
/// On Windows the rename would fail anyway — the harness holds files open inside
/// the profile it booted — and everywhere else it would succeed and leave the
/// harness reading a directory that is not there. The answer is the same either
/// way, and it is worth more said in advance than discovered.
fn idle(name: &str, state: &State<'_, AppState>) -> Result<()> {
    let running = !matches!(
        state.supervisor.status(),
        Status::Stopped | Status::Failed { .. }
    );
    if running && super::selected() == name {
        return Err(Error::Profile(format!(
            "the harness is running {name}; stop it first"
        )));
    }
    Ok(())
}

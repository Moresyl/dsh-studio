//! The IPC surface the frontend drives.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use super::install;
use super::supervisor::{Status, Stream, Supervisor};
use super::Environment;
use crate::error::{Error, Result};
use crate::node::NodeJobs;

/// Application-wide state handed to every command.
pub struct AppState {
    pub supervisor: Arc<Supervisor>,
    /// Set while an install is running, so a second click cannot start another
    /// npm against the same directory.
    installing: AtomicBool,
    /// Serializes every operation that can observe or replace the managed
    /// runtime. In particular, composition preflight belongs to startup: two
    /// callers must not both heal the profile module fallback before the
    /// supervisor's later `active` guard is reached.
    lifecycle: Mutex<()>,
}

impl AppState {
    pub fn new(supervisor: Arc<Supervisor>) -> Self {
        Self {
            supervisor,
            installing: AtomicBool::new(false),
            lifecycle: Mutex::new(()),
        }
    }
}

/// One line of harness output, shaped for the log panel.
#[derive(Serialize)]
pub struct LogLine {
    pub stream: Stream,
    pub line: String,
}

/// What this machine can run, and what it is missing.
#[tauri::command]
pub async fn harness_environment(state: State<'_, AppState>) -> Result<Environment> {
    let _lifecycle = state.lifecycle.lock().await;
    Ok(super::environment())
}

#[tauri::command]
pub fn harness_status(state: State<'_, AppState>) -> Status {
    state.supervisor.status()
}

/// Start the harness and return the origin it is serving on.
#[tauri::command]
pub async fn harness_start(state: State<'_, AppState>) -> Result<String> {
    start_managed(&state).await
}

/// Start through the one managed-runtime lifecycle gate.
///
/// Kept separate from the Tauri wrapper because the tray owns the same action
/// and must not bypass preflight or race an install.
pub(crate) async fn start_managed(state: &AppState) -> Result<String> {
    let _lifecycle = state.lifecycle.lock().await;
    let shell = super::shell_environment::resolve().await;
    state.supervisor.note(
        Stream::Stdout,
        match shell.fallback_reason {
            Some(reason) => format!("GUI shell environment: {} ({reason})", shell.source),
            None => format!("GUI shell environment: {}", shell.source),
        },
    );
    let environment = shell.updates;
    let mut plan = super::launch_plan()?;
    plan.environment = environment.clone();
    for notice in super::composition::preflight(&plan).await? {
        state.supervisor.note(Stream::Stderr, notice);
    }
    let attempted = plan.profile.clone();
    match Arc::clone(&state.supervisor).start(plan).await {
        Ok(origin) => {
            crate::profiles::mark_healthy(&attempted)?;
            Ok(origin)
        }
        Err(failure) => {
            let reason = failure.to_string();
            let Some(recovered) = crate::profiles::failed_start(&attempted, &reason)? else {
                return Err(failure);
            };

            state.supervisor.note(
                Stream::Stderr,
                format!(
                    "profile {attempted} failed startup; automatically retrying last-known-good profile {recovered}"
                ),
            );
            let mut fallback = super::launch_plan()?;
            fallback.environment = environment;
            for notice in super::composition::preflight(&fallback).await? {
                state.supervisor.note(Stream::Stderr, notice);
            }
            match Arc::clone(&state.supervisor).start(fallback).await {
                Ok(origin) => {
                    crate::profiles::mark_healthy(&recovered)?;
                    Ok(origin)
                }
                Err(fallback_failure) => Err(Error::Profile(format!(
                    "profile {attempted} failed to start ({reason}); last-known-good profile {recovered} also failed ({fallback_failure})"
                ))),
            }
        }
    }
}

#[tauri::command]
pub async fn harness_stop(state: State<'_, AppState>) -> Result<()> {
    stop_managed(&state).await
}

pub(crate) async fn stop_managed(state: &AppState) -> Result<()> {
    let _lifecycle = state.lifecycle.lock().await;
    state.supervisor.stop().await;
    Ok(())
}

/// Install the harness, or replace it with the latest release.
///
/// Resolves only once npm is done, which is a minute or more on a cold cache —
/// the progress a user sees in the meantime is npm's own output, relayed
/// through the same log everything else in the shell writes to.
#[tauri::command]
pub async fn harness_install(
    app: AppHandle,
    node_jobs: State<'_, Arc<NodeJobs>>,
    state: State<'_, AppState>,
) -> Result<()> {
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err(Error::AlreadyInstalling);
    }
    let _lifecycle = state.lifecycle.lock().await;
    let outcome = perform_install(&app, &node_jobs, &state).await;
    state.installing.store(false, Ordering::SeqCst);

    match &outcome {
        Ok(()) => state
            .supervisor
            .note(Stream::Stdout, format!("{} is installed", install::PACKAGE)),
        Err(failure) => state.supervisor.note(Stream::Stderr, failure.to_string()),
    }
    outcome
}

async fn perform_install(
    app: &AppHandle,
    node_jobs: &NodeJobs,
    state: &State<'_, AppState>,
) -> Result<()> {
    // Every shared fallback junction points into the live runtime. Leave no
    // supervised process resolving through those junctions while the verified
    // staging directory is promoted over the live directory.
    state.supervisor.stop().await;
    state.supervisor.wait_until_inactive().await?;

    if let Some(payload) = crate::offline::payload(app)? {
        state.supervisor.note(
            Stream::Stdout,
            format!(
                "installing bundled {}@{} from the Full package",
                install::PACKAGE,
                install::VERSION
            ),
        );
        return tauri::async_runtime::spawn_blocking(move || {
            install::run_bundled(&payload.harness)
        })
        .await
        .map_err(|cause| {
            Error::Install(format!("offline installation did not finish: {cause}"))
        })?;
    }

    let plan = match super::install_plan() {
        Ok(plan) => plan,
        Err(Error::NpmMissing) => {
            state.supervisor.note(
                Stream::Stdout,
                "the selected Node installation has no working npm; installing a complete Studio-managed Node runtime".into(),
            );
            crate::node::commands::provision_managed(app, node_jobs, &state.supervisor).await?;
            super::install_plan()?
        }
        Err(failure) => return Err(failure),
    };
    let supervisor = Arc::clone(&state.supervisor);
    supervisor.note(
        Stream::Stdout,
        format!("installing {} into {}", plan.spec, plan.target.display()),
    );

    let reporter = Arc::clone(&supervisor);
    install::run_transactional(&plan, move |stream, line| reporter.note(stream, line)).await?;

    // npm can exit successfully having installed something other than what we
    // need — a scope typo, a package that moved. Believe the file, not the
    // exit code.
    if !crate::paths::harness_entry().is_file() {
        return Err(Error::Install(
            "npm reported success but the harness entry point is missing".into(),
        ));
    }
    Ok(())
}

/// Output buffered since launch, so a late-opened log panel is not empty.
#[tauri::command]
pub fn harness_log(state: State<'_, AppState>) -> Vec<LogLine> {
    state
        .supervisor
        .recent_log()
        .into_iter()
        .map(|(stream, line)| LogLine { stream, line })
        .collect()
}

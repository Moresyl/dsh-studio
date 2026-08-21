//! The IPC surface the frontend drives.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::install;
use super::supervisor::{Status, Stream, Supervisor};
use super::Environment;
use crate::error::{Error, Result};

/// Application-wide state handed to every command.
pub struct AppState {
    pub supervisor: Arc<Supervisor>,
    /// Set while an install is running, so a second click cannot start another
    /// npm against the same directory.
    installing: AtomicBool,
}

impl AppState {
    pub fn new(supervisor: Arc<Supervisor>) -> Self {
        Self {
            supervisor,
            installing: AtomicBool::new(false),
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
pub fn harness_environment() -> Environment {
    super::environment()
}

#[tauri::command]
pub fn harness_status(state: State<'_, AppState>) -> Status {
    state.supervisor.status()
}

/// Start the harness and return the origin it is serving on.
#[tauri::command]
pub async fn harness_start(state: State<'_, AppState>) -> Result<String> {
    let plan = super::launch_plan()?;
    Arc::clone(&state.supervisor).start(plan).await
}

#[tauri::command]
pub async fn harness_stop(state: State<'_, AppState>) -> Result<()> {
    state.supervisor.stop().await;
    Ok(())
}

/// Install the harness, or replace it with the latest release.
///
/// Resolves only once npm is done, which is a minute or more on a cold cache —
/// the progress a user sees in the meantime is npm's own output, relayed
/// through the same log everything else in the shell writes to.
#[tauri::command]
pub async fn harness_install(state: State<'_, AppState>) -> Result<()> {
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err(Error::AlreadyInstalling);
    }
    let outcome = perform_install(&state).await;
    state.installing.store(false, Ordering::SeqCst);

    match &outcome {
        Ok(()) => state
            .supervisor
            .note(Stream::Stdout, format!("{} is installed", install::PACKAGE)),
        Err(failure) => state.supervisor.note(Stream::Stderr, failure.to_string()),
    }
    outcome
}

async fn perform_install(state: &State<'_, AppState>) -> Result<()> {
    let plan = super::install_plan()?;
    let supervisor = Arc::clone(&state.supervisor);
    supervisor.note(
        Stream::Stdout,
        format!("installing {} into {}", plan.spec, plan.target.display()),
    );

    let reporter = Arc::clone(&supervisor);
    install::run_transactional(&plan, supervisor.guard(), move |stream, line| {
        reporter.note(stream, line)
    })
    .await?;

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

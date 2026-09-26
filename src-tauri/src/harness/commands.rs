//! The IPC surface the frontend drives.

use std::collections::HashMap;
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

struct InstallingGuard<'a>(&'a AtomicBool);

impl Drop for InstallingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
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
#[derive(Debug, Serialize)]
pub struct LogLine {
    pub stream: Stream,
    pub line: String,
}

/// A published Harness release, annotated with the Studio runtime contract.
///
/// The registry is an authority for what exists, not for what this desktop
/// build can safely boot. Keeping that distinction in the response lets the
/// UI distinguish the bundled baseline from versions requiring a local
/// installation and startup check before promotion.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessVersion {
    pub version: String,
    pub qualified: bool,
    pub installed: bool,
}

#[derive(serde::Deserialize)]
struct NpmMetadata {
    versions: HashMap<String, serde_json::Value>,
}

const HARNESSES_REGISTRY: &str = "https://registry.npmjs.org/@deepseek-ai%2Fdsh";
const MAX_HARNESS_VERSIONS: usize = 50;

fn parse_harness_versions(raw: &str, installed: Option<&str>) -> Result<Vec<HarnessVersion>> {
    let metadata: NpmMetadata = serde_json::from_str(raw)
        .map_err(|cause| Error::Network(format!("Harness version catalog is invalid: {cause}")))?;
    let mut versions = metadata
        .versions
        .into_keys()
        .filter_map(|version| {
            semver::Version::parse(&version)
                .ok()
                .map(|parsed| (parsed, version))
        })
        .filter(|(parsed, _)| parsed.build.is_empty())
        .collect::<Vec<_>>();
    versions.sort_by(|left, right| {
        let retained = |version: &str| version == install::VERSION || Some(version) == installed;
        retained(&right.1)
            .cmp(&retained(&left.1))
            .then_with(|| right.0.cmp(&left.0))
    });
    versions.truncate(MAX_HARNESS_VERSIONS);
    versions.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(versions
        .into_iter()
        .map(|(_, version)| HarnessVersion {
            qualified: version == install::VERSION,
            installed: installed.is_some_and(|current| current == version),
            version,
        })
        .collect())
}

/// Return a bounded, exact-version view of the published Harness releases.
///
/// Metadata never certifies compatibility. Selected versions must pass the
/// isolated install and startup checks before replacing the current runtime.
#[tauri::command]
pub async fn harness_versions() -> Result<Vec<HarnessVersion>> {
    let client = crate::node::http::client()?;
    let body = crate::node::http::text(&client, HARNESSES_REGISTRY).await?;
    parse_harness_versions(
        &body,
        install::runtime_version(&crate::paths::harness_dir()).as_deref(),
    )
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

/// Stop any current Harness and boot the Studio-owned isolated recovery
/// profile. The user's selected profile and plugin files are not changed.
#[tauri::command]
pub async fn harness_safe_mode_start(state: State<'_, AppState>) -> Result<String> {
    let _lifecycle = state.lifecycle.lock().await;
    state.supervisor.stop().await;
    state.supervisor.wait_until_inactive().await?;

    let shell = super::shell_environment::resolve().await;
    state.supervisor.note(
        Stream::Stdout,
        match shell.fallback_reason {
            Some(reason) => format!("GUI shell environment: {} ({reason})", shell.source),
            None => format!("GUI shell environment: {}", shell.source),
        },
    );
    let mut plan = super::safe_mode_launch_plan()?;
    plan.environment = shell.updates;
    for notice in super::composition::preflight(&plan).await? {
        state.supervisor.note(Stream::Stderr, notice);
    }
    state.supervisor.note(
        Stream::Stdout,
        "starting isolated safe mode; the selected profile is unchanged".into(),
    );
    Arc::clone(&state.supervisor).start(plan).await
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
    version: Option<String>,
    plugin_jobs: State<'_, Arc<crate::plugins::PluginJobs>>,
) -> Result<()> {
    let version = version.unwrap_or_else(install::selected_version);
    install::validate_version(&version)?;
    // Profile commands resolve through the live runtime; do not replace it
    // while another window is installing a plugin or switching profiles.
    let _plugins = plugin_jobs.claim()?;
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err(Error::AlreadyInstalling);
    }
    let _installing = InstallingGuard(&state.installing);
    let _lifecycle = state.lifecycle.lock().await;
    let outcome = perform_install(&app, &node_jobs, &state, &version).await;

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
    version: &str,
) -> Result<()> {
    // Every shared fallback junction points into the live runtime. Leave no
    // supervised process resolving through those junctions while the verified
    // staging directory is promoted over the live directory.
    state.supervisor.stop().await;
    state.supervisor.wait_until_inactive().await?;

    if let Some(payload) = crate::offline::payload(app)?.filter(|_| version == install::VERSION) {
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

    let mut plan = match super::install_plan() {
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
    plan.spec = format!("{}@{version}", install::PACKAGE);
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

#[cfg(test)]
mod tests {
    use super::parse_harness_versions;
    use crate::harness::install;

    #[test]
    fn catalog_is_bounded_sorted_and_marks_only_the_qualified_contract() {
        let mut entries = serde_json::Map::new();
        for version in ["0.1.0-rc.1", "0.1.1-rc.2", "0.1.5-rc.2"] {
            entries.insert(version.into(), serde_json::json!({}));
        }
        entries.insert(install::VERSION.into(), serde_json::json!({}));
        entries.insert("not-semver".into(), serde_json::json!({}));
        entries.insert("1.0.0+build".into(), serde_json::json!({}));
        let raw = serde_json::json!({
            "versions": entries
        })
        .to_string();
        let versions = parse_harness_versions(&raw, Some(install::VERSION)).expect("catalog");
        assert_eq!(versions[0].version, install::VERSION);
        assert!(versions
            .iter()
            .any(|version| version.version == install::VERSION
                && version.qualified
                && version.installed));
        assert!(!versions
            .iter()
            .any(|version| version.version == "not-semver"));
        assert!(!versions
            .iter()
            .any(|version| version.version == "1.0.0+build"));
    }

    #[test]
    fn malformed_catalog_is_an_actionable_network_error() {
        let error = parse_harness_versions("[]", None).expect_err("invalid catalog");
        assert!(error.to_string().contains("version catalog is invalid"));
    }

    #[test]
    fn truncated_catalog_keeps_the_bundled_and_installed_versions() {
        let mut entries = serde_json::Map::new();
        for minor in 0..100 {
            entries.insert(format!("1.{minor}.0"), serde_json::json!({}));
        }
        entries.insert(install::VERSION.into(), serde_json::json!({}));
        entries.insert("0.1.0-rc.8".into(), serde_json::json!({}));
        let raw = serde_json::json!({"versions": entries}).to_string();
        let result = parse_harness_versions(&raw, Some("0.1.0-rc.8")).expect("catalog");
        assert_eq!(result.len(), 50);
        assert!(result.iter().any(|version| version.qualified));
        assert!(result.iter().any(|version| version.installed));
    }
}

//! The plugin marketplace: what is installed, and changing it.
//!
//! Plugins are ordinary npm packages that declare a profile patch, and the
//! harness already knows how to add and remove them — `dsh plugin` installs
//! into the profile directory and then reconciles the layer list against what
//! is actually on disk. Reimplementing that reconciliation here would mean
//! owning a copy of someone else's rule, so this module does not: it reads the
//! profile manifest to say what is installed, and it drives the harness's own
//! command to change it.
//!
//! What the shell does add is the part a desktop user cannot reasonably be
//! asked to do themselves. `dsh plugin` forwards to pnpm and gives up if pnpm
//! is not on PATH; a person who installed a desktop app has not agreed to go
//! and install a package manager first. So the shell keeps one under its own
//! data directory and puts it on the PATH of that one child process — not on
//! the user's, and not on any other program's.

pub mod archive;
pub mod catalog;
pub mod commands;
pub mod market;
pub mod media;
pub mod receipts;
pub mod recovery;
pub mod registry;
pub mod switches;

use std::collections::{BTreeSet, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use proc_guard::ProcessGuard;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::{Error, Result};
use crate::harness::install;
use crate::harness::supervisor::Stream;
use crate::paths;

/// One entry in the profile's plugin list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub name: String,
    /// The range recorded in the profile manifest, empty for an in-box bundle.
    pub spec: String,
    /// In the layer stack: this package declares a profile patch, and the patch
    /// is applied. A dependency that is installed but inactive is a plain
    /// library, which is allowed and worth showing as different.
    pub active: bool,
    /// Installed and left installed, but taken out of the layer stack by the
    /// user. Distinct from a plain library, which was never in it: this one can
    /// be switched back on without a download.
    pub disabled: bool,
    /// Part of the profile template rather than something installed here.
    /// Shown because it explains the harness's behaviour, never removable.
    pub builtin: bool,
    /// Receipt id when this exact profile package came from the market.
    pub market_receipt: Option<String>,
}

/// Everything the plugin panel needs before it draws anything.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub profile: String,
    pub profile_dir: PathBuf,
    /// False until the harness has initialized the profile. The first install
    /// creates it, so this is a fact to display, not an error to report.
    pub initialized: bool,
    pub plugins: Vec<InstalledPlugin>,
    /// Whether a package manager is reachable. When false the first change
    /// installs one first, which is slow enough that the panel should say so.
    pub package_manager: bool,
}

/// Guard so two clicks cannot run two package managers over one directory.
#[derive(Debug, Default)]
pub struct PluginJobs {
    pub busy: AtomicBool,
}

impl PluginJobs {
    /// Claim the one profile-wide package-manager slot.
    ///
    /// The returned guard clears the flag on every exit path, including task
    /// cancellation when a window closes halfway through a profile import.
    pub(crate) fn claim(&self) -> Result<PluginJob<'_>> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(Error::PluginBusy);
        }
        Ok(PluginJob(&self.busy))
    }
}

/// A package-manager claim that cannot be stranded by an early return or a
/// cancelled async command.
pub(crate) struct PluginJob<'a>(&'a AtomicBool);

impl Drop for PluginJob<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

const INTENT_TTL: Duration = Duration::from_secs(2 * 60);
const MAX_INTENTS: usize = 64;

#[derive(Clone, Debug)]
pub struct InstallIntent {
    pub profile: String,
    pub spec: String,
    pub source_id: String,
    pub item_id: String,
    pub display_name: String,
    expires_at: Instant,
}

/// One-shot native confirmations for market installs.
#[derive(Debug, Default)]
pub struct PluginIntents {
    entries: Mutex<VecDeque<(String, InstallIntent)>>,
}

impl PluginIntents {
    pub fn issue(
        &self,
        profile: String,
        spec: String,
        source_id: String,
        item_id: String,
        display_name: String,
    ) -> Result<String> {
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random)
            .map_err(|_| Error::Plugin("could not create an install confirmation".into()))?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| Error::Plugin("install confirmation state is unavailable".into()))?;
        purge_intents(&mut entries);
        entries.push_back((
            token.clone(),
            InstallIntent {
                profile,
                spec,
                source_id,
                item_id,
                display_name,
                expires_at: Instant::now() + INTENT_TTL,
            },
        ));
        while entries.len() > MAX_INTENTS {
            entries.pop_front();
        }
        Ok(token)
    }

    pub fn consume(&self, token: &str, profile: &str) -> Result<InstallIntent> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| Error::Plugin("install confirmation state is unavailable".into()))?;
        purge_intents(&mut entries);
        let index = entries
            .iter()
            .position(|(candidate, _)| candidate == token)
            .ok_or_else(|| {
                Error::Plugin(
                    "the install confirmation expired or was already used; preview it again".into(),
                )
            })?;
        let (_, intent) = entries.remove(index).expect("the intent index exists");
        if intent.profile != profile {
            return Err(Error::Plugin(
                "the active profile changed after the install preview; preview it again".into(),
            ));
        }
        Ok(intent)
    }

    /// Read a confirmation without spending it while registry and source
    /// checks are still allowed to fail. `consume` remains the only operation
    /// that authorizes the profile write.
    pub fn inspect(&self, token: &str, profile: &str) -> Result<InstallIntent> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| Error::Plugin("install confirmation state is unavailable".into()))?;
        purge_intents(&mut entries);
        let intent = entries
            .iter()
            .find(|(candidate, _)| candidate == token)
            .map(|(_, intent)| intent.clone())
            .ok_or_else(|| {
                Error::Plugin(
                    "the install confirmation expired or was already used; preview it again".into(),
                )
            })?;
        if intent.profile != profile {
            return Err(Error::Plugin(
                "the active profile changed after the install preview; preview it again".into(),
            ));
        }
        Ok(intent)
    }
}

fn purge_intents(entries: &mut VecDeque<(String, InstallIntent)>) {
    let now = Instant::now();
    entries.retain(|(_, intent)| intent.expires_at > now);
}

/// What a change does to the profile.
#[derive(Clone, Copy, Debug)]
pub enum Change {
    Add,
    Remove,
}

impl Change {
    fn verb(self) -> &'static str {
        match self {
            // pnpm's own subcommands, because that is what `dsh plugin`
            // forwards its arguments to.
            Change::Add => "add",
            Change::Remove => "remove",
        }
    }
}

/// Read the hosted profile as it is right now. Cheap; safe to call on every
/// render — which is also why the profile is read here rather than passed in:
/// the panel describes whichever profile this window is hosting at the moment it
/// draws, and a stale answer would be a list of the wrong profile's plugins.
pub fn state() -> PluginState {
    let profile = crate::profiles::selected();
    let profile_dir = paths::profile_dir(&profile);
    let manifest = read_manifest(&profile_dir);

    let switched_off = switches::switched_off(&profile);

    let mut plugins = manifest
        .as_ref()
        .map(|manifest| list(manifest, &switched_off))
        .unwrap_or_default();
    let receipt_ids = receipts::ids(&profile, &profile_dir);
    for plugin in &mut plugins {
        plugin.market_receipt = receipt_ids.get(&plugin.name).cloned();
    }

    PluginState {
        profile,
        initialized: manifest.is_some(),
        plugins,
        package_manager: package_manager_available(),
        profile_dir,
    }
}

pub(crate) fn read_manifest(profile_dir: &Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(profile_dir.join("package.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Turn the manifest into the list the panel shows.
///
/// Three sources, deliberately merged: `dependencies` is what was installed,
/// `dsh.profile.bundles` is what is switched on, and `switched_off` is what the
/// user took out of that list. A name in the second but not the first came with
/// the profile template.
pub(crate) fn list(
    manifest: &serde_json::Value,
    switched_off: &BTreeSet<String>,
) -> Vec<InstalledPlugin> {
    let bundles: Vec<&str> = manifest
        .pointer("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect()
        })
        .unwrap_or_default();

    let mut plugins: Vec<InstalledPlugin> = manifest
        .get("dependencies")
        .and_then(serde_json::Value::as_object)
        .map(|dependencies| {
            dependencies
                .iter()
                .map(|(name, spec)| InstalledPlugin {
                    active: bundles.contains(&name.as_str()),
                    disabled: switched_off.contains(name),
                    name: name.clone(),
                    spec: spec.as_str().unwrap_or_default().to_string(),
                    builtin: false,
                    market_receipt: None,
                })
                .collect()
        })
        .unwrap_or_default();

    for name in bundles {
        if !plugins.iter().any(|plugin| plugin.name == name) {
            plugins.push(InstalledPlugin {
                name: name.to_string(),
                spec: String::new(),
                active: true,
                disabled: false,
                builtin: true,
                market_receipt: None,
            });
        }
    }

    // Installed plugins first — they are what the user acted on — then the
    // in-box bundles, each group alphabetical so the list does not reshuffle.
    plugins.sort_by(|left, right| {
        left.builtin
            .cmp(&right.builtin)
            .then_with(|| left.name.cmp(&right.name))
    });
    plugins
}

/// Add or remove one plugin, reporting every line the tools produce.
///
/// The package manager is bootstrapped first if this machine has none, because
/// the alternative is a 127 exit code and a message telling a desktop user to
/// go and install pnpm.
pub async fn change_finalize<R, F>(
    change: Change,
    spec: &str,
    retry: recovery::RetryPlan,
    guard: &ProcessGuard,
    report: R,
    finalize: F,
) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
    F: FnOnce() -> Result<()>,
{
    if !is_package_spec(spec) {
        return Err(Error::Plugin(format!(
            "{spec} is not a package name this panel will pass on"
        )));
    }

    let profile = crate::profiles::selected();
    change_profile_finalize(&profile, change, spec, retry, guard, report, finalize).await
}

/// The same transaction against an explicit profile, used only by a
/// generation-checked recovery retry.
pub async fn change_profile_finalize<R, F>(
    profile: &str,
    change: Change,
    spec: &str,
    retry: recovery::RetryPlan,
    guard: &ProcessGuard,
    report: R,
    finalize: F,
) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
    F: FnOnce() -> Result<()>,
{
    if !is_package_spec(spec) {
        return Err(Error::Plugin(format!(
            "{spec} is not a package name this panel will pass on"
        )));
    }
    let transaction = recovery::begin(profile, change.verb(), spec, Some(retry))?;
    let outcome = run(
        profile,
        &[change.verb().to_string(), spec.to_string()],
        guard,
        report,
    )
    .await;
    if let Err(failure) = outcome {
        return match transaction.rollback() {
            Ok(_) => Err(failure),
            Err(rollback) => Err(Error::Plugin(format!(
                "{failure}; automatic profile rollback also failed: {rollback}"
            ))),
        };
    }

    // The harness has just rebuilt the layer list from what is installed, which
    // puts back anything the user had switched off. Saying so again here is the
    // only reason a switched-off plugin stays switched off across an install.
    if let Err(failure) = switches::apply(profile, &paths::profile_dir(profile)) {
        return match transaction.rollback() {
            Ok(_) => Err(failure),
            Err(rollback) => Err(Error::Plugin(format!(
                "{failure}; automatic profile rollback also failed: {rollback}"
            ))),
        };
    }
    if let Err(failure) = finalize() {
        return match transaction.rollback() {
            Ok(_) => Err(failure),
            Err(rollback) => Err(Error::Plugin(format!(
                "{failure}; automatic profile rollback also failed: {rollback}"
            ))),
        };
    }
    transaction.commit()
}

/// Install a plugin from a file on this machine instead of from a registry.
///
/// The point of it is the machine with no route to a registry at all, which is
/// where a plugin arrives as a file somebody carried in. Everything after the
/// first two lines is the same install the market does, and the two lines are
/// the whole difference: the archive is read first so the panel can say what is
/// in it, and it is copied somewhere the app owns before pnpm is pointed at it.
///
/// That copy is not tidiness. pnpm records a tarball install as the path it was
/// installed from, so the file becomes part of the profile — reinstalling or
/// duplicating that profile reads the same path again, and the path the user
/// picked may well have been on a stick that has since been taken out.
pub async fn import<R>(path: &Path, guard: &ProcessGuard, report: R) -> Result<archive::Package>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    let package = archive::read(path)?;
    let kept = archive::stage(path, &package)?;

    let profile = crate::profiles::selected();
    let transaction = recovery::begin(&profile, "import", &package.name, None)?;
    let installed = run(
        &profile,
        &[Change::Add.verb().to_string(), archive::spec(&kept.path)],
        guard,
        report,
    )
    .await;

    if let Err(failure) = installed {
        // Only ever a copy this import made. The same archive may be what an
        // existing profile was installed from, and taking it away would break
        // that profile the next time anybody duplicates or reinstalls it. The
        // removal itself is best-effort: the install already failed, and a
        // leftover file in the app's own directory is not worth replacing that
        // failure with a less useful one.
        if kept.fresh {
            let _ = std::fs::remove_file(&kept.path);
        }
        return match transaction.rollback() {
            Ok(_) => Err(failure),
            Err(rollback) => Err(Error::Plugin(format!(
                "{failure}; automatic profile rollback also failed: {rollback}"
            ))),
        };
    }

    // Same as `change`: the harness has just rebuilt the layer list from what is
    // installed, which puts back anything the user had switched off.
    if let Err(failure) = switches::apply(&profile, &paths::profile_dir(&profile)) {
        return match transaction.rollback() {
            Ok(_) => Err(failure),
            Err(rollback) => Err(Error::Plugin(format!(
                "{failure}; automatic profile rollback also failed: {rollback}"
            ))),
        };
    }
    transaction.commit()?;
    Ok(package)
}

/// Run one `dsh plugin` invocation against `profile` and report its output.
///
/// Separate from [`change`] because installing into a profile is not only what
/// the market does: a profile copied from another one has to be given what the
/// original had installed, and that is the same command with different arguments.
/// Both go through here so there is one place that knows how to find a package
/// manager and where the child's working directory has to be.
pub async fn run<R>(profile: &str, args: &[String], guard: &ProcessGuard, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    let environment = crate::harness::environment();
    let node = environment.node.ok_or(Error::NoNodeRuntime {
        minimum: node_runtime::MINIMUM_SUPPORTED,
    })?;
    if !environment.harness_installed {
        return Err(Error::HarnessNotInstalled);
    }
    if !environment.harness_compatible {
        return Err(Error::Plugin(format!(
            "plugins require the verified Harness runtime {}; repair it from the Environment panel first",
            crate::harness::install::VERSION
        )));
    }
    let manager_node = environment
        .all_node_runtimes
        .iter()
        .find(|install| {
            install.version >= node_runtime::MINIMUM_SUPPORTED
                && install::npm_cli(&install.path).is_some()
        })
        .map(|install| install.path.as_path())
        .unwrap_or(node.path.as_path());
    let manager = ensure_package_manager(manager_node, report.clone()).await?;
    let profile_dir = paths::profile_dir(profile);
    let store = profile_store_dir(&profile_dir);
    let registry = registry::configured_base(&node.path).await;

    let mut command = Command::new(&node.path);
    command
        .arg(&environment.harness_entry)
        .arg("plugin")
        .arg("--profile")
        .arg(profile)
        .args(args)
        // Relative specs would be anchored against this directory, and nothing
        // that reaches here is one — package names and absolute archive paths
        // only. So it exists to be somewhere predictable rather than wherever
        // the app happened to be launched from.
        .current_dir(paths::app_data_dir())
        .env("PATH", path_with(&node.path, manager.as_deref()))
        // Installation must use the same source whose metadata and integrity
        // the review checked, even when a profile carries an old local .npmrc.
        .env("npm_config_registry", registry)
        // pnpm otherwise follows whichever global config happens to be active
        // in the GUI environment. Preserve the store an existing profile is
        // already linked to; give a new profile one stable Studio-owned store.
        .env("npm_config_store_dir", &store)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: pnpm is a console program, and a black rectangle
        // appearing over the app is not progress reporting.
        command.creation_flags(0x0800_0000);
    }

    let mut child = guard.spawn(&mut command).map_err(Error::Spawn)?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let out = tokio::spawn(forward(stdout, Stream::Stdout, report.clone()));
    let err = tokio::spawn(forward(stderr, Stream::Stderr, report));

    let status = child.wait().await.map_err(|cause| {
        Error::Plugin(format!(
            "the plugin command could not be waited on: {cause}"
        ))
    })?;
    let (out, err) = tokio::join!(out, err);

    if !status.success() {
        // Every line went to the console, but the button that started this is in
        // the plugin panel, and an exit code on its own gives the person who
        // pressed it nothing to act on. So the failure carries its own reason.
        return Err(Error::Plugin(
            match package_manager_reason(joined(out), joined(err)) {
                Some(reason) => format!("the plugin command failed ({status}): {reason}"),
                None => format!("the plugin command exited with {status} without saying why"),
            },
        ));
    }
    Ok(())
}

/// Resolve the complete dependency graph in a disposable project before the
/// profile transaction begins.
///
/// Registry metadata alone proves only that the selected package exists. pnpm
/// can still fail later because one of that package's dependencies was
/// unpublished, made private, or is absent from the configured mirror. Running
/// the same pinned pnpm with a lockfile-only install catches that class without
/// running lifecycle scripts or writing to the user's profile.
pub async fn verify_installable<R>(spec: &str, guard: &ProcessGuard, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    let (name, version) = split_spec(spec);
    let version = version.ok_or_else(|| {
        Error::Plugin("dependency preflight requires an exact package version".into())
    })?;
    let environment = crate::harness::environment();
    let node = environment.node.ok_or(Error::NoNodeRuntime {
        minimum: node_runtime::MINIMUM_SUPPORTED,
    })?;
    if !environment.harness_installed || !environment.harness_compatible {
        return Err(Error::Plugin(
            "dependency preflight requires a verified Harness runtime".into(),
        ));
    }
    let manager_node = environment
        .all_node_runtimes
        .iter()
        .find(|install| {
            install.version >= node_runtime::MINIMUM_SUPPORTED
                && install::npm_cli(&install.path).is_some()
        })
        .map(|install| install.path.as_path())
        .unwrap_or(node.path.as_path());
    let manager = ensure_package_manager(manager_node, report.clone())
        .await?
        .ok_or_else(|| Error::Plugin("the verified pnpm executable is unavailable".into()))?;
    let pnpm = manager_cli(&manager).ok_or_else(|| {
        Error::Plugin("the verified pnpm package has no command entry point".into())
    })?;
    let project = PreflightProject::create(name, version)?;
    let registry = registry::configured_base(&node.path).await;

    report(
        Stream::Stdout,
        format!("checking every dependency required by {spec}"),
    );
    let mut command = Command::new(&node.path);
    command
        .arg(pnpm)
        .arg("--dir")
        .arg(project.path())
        .arg("install")
        .arg("--lockfile-only")
        .arg("--ignore-scripts")
        .arg("--reporter=append-only")
        .arg("--config.auto-install-peers=false")
        .env("CI", "true")
        .env("npm_config_registry", registry)
        .env("npm_config_store_dir", paths::plugin_store_dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let mut child = guard.spawn(&mut command).map_err(Error::Spawn)?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let out = tokio::spawn(forward(stdout, Stream::Stdout, report.clone()));
    let err = tokio::spawn(forward(stderr, Stream::Stderr, report));
    let status = child.wait().await.map_err(|cause| {
        Error::Plugin(format!(
            "dependency preflight could not be waited on: {cause}"
        ))
    })?;
    let (out, err) = tokio::join!(out, err);
    if status.success() {
        return Ok(());
    }

    let reason = package_manager_reason(joined(out), joined(err))
        .unwrap_or_else(|| format!("pnpm exited with {status} without saying why"));
    Err(Error::Plugin(format!(
        "{spec} cannot be installed because its dependency graph did not resolve: {reason}. The profile was not changed"
    )))
}

/// Switch an installed plugin on or off without uninstalling it.
///
/// Cheap in a way installing is not — nothing is fetched, nothing is spawned,
/// and the package stays on disk — so this is the reversible half of the panel,
/// and the one to reach for when someone is only trying something out.
pub fn switch(name: &str, enabled: bool) -> Result<()> {
    if !is_package_spec(name) {
        return Err(Error::Plugin(format!(
            "{name} is not a package name this panel will pass on"
        )));
    }

    // The profile template's own bundles are what make the harness a harness.
    // Switching one off would leave a running application with no interface and
    // no obvious way back; they are shown, and they are not ours to turn off.
    let hosted = state();
    if hosted
        .plugins
        .iter()
        .any(|plugin| plugin.name == name && plugin.builtin)
    {
        return Err(Error::Plugin(format!(
            "{name} came with the profile and cannot be switched off"
        )));
    }

    switches::set(&hosted.profile, name, enabled, &hosted.profile_dir)
}

/// How many trailing lines are kept to explain a failure. Enough to hold an
/// `ERR_PNPM_*` heading and the sentence under it; short enough to read at once.
const TAIL_LINES: usize = 16;

/// Report every line of a stream, and hand back the last few of them.
async fn forward<P, R>(pipe: P, stream: Stream, report: R) -> Vec<String>
where
    P: tokio::io::AsyncRead + Unpin,
    R: Fn(Stream, String),
{
    let mut reader = BufReader::new(pipe);
    let mut raw: Vec<u8> = Vec::new();
    let mut tail: VecDeque<String> = VecDeque::with_capacity(TAIL_LINES);

    // Bytes rather than `lines()`: a shell on a Chinese Windows writes its
    // errors in the OEM code page, and a UTF-8 line reader ends the stream at
    // the first byte it cannot decode — dropping the rest of the output at
    // precisely the moment someone has a reason to read it.
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }

        let line = String::from_utf8_lossy(&raw).trim_end().to_string();
        if line.is_empty() {
            continue;
        }
        if tail.len() == TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line.clone());
        report(stream, line);
    }

    tail.into()
}

/// What a stream said last, as one line an error message can carry.
fn joined(collected: std::result::Result<Vec<String>, tokio::task::JoinError>) -> Vec<String> {
    collected.unwrap_or_default()
}

/// Prefer the package manager's actual error over a harness wrapper printed to
/// the other stream. The old stderr-first tail regularly reduced a useful
/// `ERR_PNPM_FETCH_404` to only "pnpm failed in profile directory".
fn package_manager_reason(stdout: Vec<String>, stderr: Vec<String>) -> Option<String> {
    let meaningful = |lines: &[String]| {
        let start = lines.iter().position(|line| {
            line.contains("ERR_PNPM_")
                || line.contains("npm ERR!")
                || line.contains("npm error code")
                || line.contains("EAI_AGAIN")
                || line.contains("ECONNREFUSED")
                || line.contains("ETIMEDOUT")
                || line.contains("ENOSPC")
        })?;
        let reason = lines[start..]
            .iter()
            .filter(|line| !line.trim().is_empty())
            .take(6)
            .cloned()
            .collect::<Vec<_>>()
            .join(" · ");
        Some(crate::logging::redact_secrets(&reason))
    };

    meaningful(&stdout)
        .or_else(|| meaningful(&stderr))
        .or_else(|| {
            [stderr.as_slice(), stdout.as_slice()]
                .into_iter()
                .find_map(|lines| {
                    let reason = lines
                        .iter()
                        .filter(|line| !line.trim().is_empty())
                        .rev()
                        .take(6)
                        .cloned()
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join(" · ");
                    (!reason.is_empty()).then(|| crate::logging::redact_secrets(&reason))
                })
        })
}

/// One narrowly named temporary project. Drop removes only the child this
/// process created, never the shared preflight root.
struct PreflightProject(PathBuf);

impl PreflightProject {
    fn create(name: &str, version: &str) -> Result<Self> {
        let root = paths::plugin_preflight_dir();
        std::fs::create_dir_all(&root).map_err(|cause| {
            Error::Plugin(format!(
                "dependency preflight directory could not be created: {cause}"
            ))
        })?;
        let mut random = [0_u8; 8];
        getrandom::fill(&mut random).map_err(|_| {
            Error::Plugin("isolated dependency project could not be named safely".into())
        })?;
        let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = root.join(format!("{}-{nonce}", std::process::id()));
        std::fs::create_dir(&path).map_err(|cause| {
            Error::Plugin(format!(
                "isolated dependency project could not be created: {cause}"
            ))
        })?;
        let mut dependencies = serde_json::Map::new();
        dependencies.insert(
            name.to_string(),
            serde_json::Value::String(version.to_string()),
        );
        let manifest = serde_json::to_string_pretty(&serde_json::json!({
            "name": "dsh-studio-plugin-preflight",
            "version": "0.0.0",
            "private": true,
            "dependencies": dependencies,
            "pnpm": { "onlyBuiltDependencies": [] }
        }))
        .map_err(|cause| {
            Error::Plugin(format!(
                "dependency preflight could not be prepared: {cause}"
            ))
        })?;
        if let Err(cause) = std::fs::write(path.join("package.json"), manifest) {
            let _ = std::fs::remove_dir_all(&path);
            return Err(Error::Plugin(format!(
                "dependency preflight manifest could not be written: {cause}"
            )));
        }
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PreflightProject {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn manager_cli(directory: &Path) -> Option<PathBuf> {
    let cli = directory.parent()?.join("pnpm/bin/pnpm.cjs");
    cli.is_file().then_some(cli)
}

/// Whether the harness will find a package manager when it looks for one.
pub fn package_manager_available() -> bool {
    managed_manager().is_some()
}

/// Make sure there is a pnpm to forward to, installing one if there is not.
///
/// Returns the directory to prepend to the child's PATH, or `None` when the
/// machine already had pnpm and nothing needs prepending.
async fn ensure_package_manager<R>(node: &Path, report: R) -> Result<Option<PathBuf>>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    if let Some(directory) = managed_manager() {
        return Ok(Some(directory));
    }
    report(
        Stream::Stdout,
        format!(
            "installing the verified plugin package manager pnpm {}",
            install::PNPM_VERSION
        ),
    );
    let plan = install::plan(node, paths::tools_dir(), install::PNPM_SPEC.to_string())?;
    install::run(&plan, report).await?;

    managed_manager().map(Some).ok_or_else(|| {
        Error::Plugin("the package manager installed but left no executable behind".into())
    })
}

/// The `.bin` directory of a verified pnpm already owned by Studio.
///
/// The managed Harness contract already carries this exact pnpm. Reusing it
/// avoids a second download and prevents the market from claiming there is no
/// package manager immediately after a successful Harness install. The
/// separate tools prefix remains the first choice so a future Harness repair
/// cannot interrupt an in-flight profile operation.
fn managed_manager() -> Option<PathBuf> {
    [paths::tools_dir(), paths::harness_dir()]
        .into_iter()
        .find_map(|root| manager_in(&root))
}

/// A qualified pnpm below one npm project root.
///
/// npm writes the platform's own launcher into `.bin` — a `.cmd` on Windows, a
/// symlink elsewhere — which is exactly what the harness's PATH lookup expects
/// to find, so nothing here has to write a shim of its own.
fn manager_in(root: &Path) -> Option<PathBuf> {
    let manifest = root.join("node_modules/pnpm/package.json");
    let version = std::fs::read_to_string(manifest)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.get("version")?.as_str().map(str::to_string));
    if version.as_deref() != Some(install::PNPM_VERSION) {
        return None;
    }
    let directory = root.join("node_modules").join(".bin");
    executable_in(&directory, "pnpm").map(|_| directory)
}

/// Keep an existing profile attached to the store recorded by pnpm itself.
///
/// pnpm 10 writes `.modules.yaml` as JSON; older releases used YAML. The JSON
/// path is exact and the small scalar fallback deliberately accepts only an
/// absolute path, never flags or shell text. A missing or unreadable marker is
/// a new profile and gets Studio's stable store.
fn profile_store_dir(profile_dir: &Path) -> PathBuf {
    let marker = profile_dir.join("node_modules/.modules.yaml");
    let recorded = std::fs::read_to_string(marker).ok().and_then(|raw| {
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| value.get("storeDir")?.as_str().map(PathBuf::from))
            .or_else(|| {
                raw.lines().find_map(|line| {
                    let value = line.trim().strip_prefix("storeDir:")?.trim();
                    let value = value.trim_matches(['\'', '"']);
                    (!value.is_empty()).then(|| PathBuf::from(value))
                })
            })
    });
    recorded
        .filter(|path| path.is_absolute())
        .unwrap_or_else(paths::plugin_store_dir)
}

fn executable_in(directory: &Path, stem: &str) -> Option<PathBuf> {
    // Windows resolves a bare name through PATHEXT, so the launcher may carry
    // any of these; everywhere else the name is the whole story.
    #[cfg(windows)]
    let candidates = [
        format!("{stem}.cmd"),
        format!("{stem}.exe"),
        format!("{stem}.bat"),
        stem.to_string(),
    ];
    #[cfg(not(windows))]
    let candidates = [stem.to_string()];

    candidates
        .into_iter()
        .map(|name| directory.join(name))
        .find(|candidate| candidate.is_file())
}

/// `PATH` for the child: the chosen Node first, then any managed pnpm, then
/// whatever the user has. Nothing is written to the user's own environment.
///
/// Every entry added here is passed through [`node_runtime::plain_path`], and
/// that is not decoration. `dsh plugin` reaches pnpm through a shell, so these
/// directories are searched by `cmd.exe`, which cannot read Windows'
/// extended-length spelling — an entry it cannot read is not an entry it skips,
/// it is a launch that fails with "the system cannot find the path specified"
/// and an exit code with no explanation attached. A `PATH` is a promise that
/// something can be found in it, and it is cheap to keep that promise here
/// rather than trust every caller to have.
fn path_with(node: &Path, manager: Option<&Path>) -> OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut entries: Vec<PathBuf> = Vec::new();

    if let Some(directory) = node.parent() {
        entries.push(node_runtime::plain_path(directory.to_path_buf()));
    }
    if let Some(directory) = manager {
        entries.push(node_runtime::plain_path(directory.to_path_buf()));
    }
    entries.extend(std::env::split_paths(&existing));
    std::env::join_paths(entries).unwrap_or(existing)
}

/// Whether a string is a package name, optionally with a version.
///
/// Everything here is spawned without a shell, so this is not about quoting. It
/// is about the one thing that would otherwise slip through: an argument
/// beginning with `-` is a flag to the package manager, not a package, and a
/// relative path spec would be resolved somewhere the user did not mean.
pub(crate) fn is_package_spec(spec: &str) -> bool {
    if spec.is_empty() || spec.len() > 214 {
        return false;
    }
    if spec.starts_with('-') || spec.chars().any(char::is_whitespace) {
        return false;
    }

    let (name, version) = split_spec(spec);
    if version.is_some_and(|range| range.is_empty() || range.contains(':')) {
        return false;
    }
    is_package_name(name)
}

/// Split `@scope/name@^1.2.3` at the separator that is not the scope marker.
pub(crate) fn split_spec(spec: &str) -> (&str, Option<&str>) {
    let scoped = usize::from(spec.starts_with('@'));
    match spec[scoped..].find('@') {
        Some(at) => (&spec[..scoped + at], Some(&spec[scoped + at + 1..])),
        None => (spec, None),
    }
}

fn is_package_name(name: &str) -> bool {
    match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((scope, rest)) => is_name_segment(scope) && is_name_segment(rest),
            None => false,
        },
        None => is_name_segment(name),
    }
}

fn is_name_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 128
        && !segment.starts_with(['.', '_'])
        && segment.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '.' | '_')
        })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[cfg(windows)]
    use std::path::Path;

    use std::collections::BTreeSet;

    #[cfg(windows)]
    use super::path_with;
    use super::{
        forward, is_package_spec, list, manager_cli, manager_in, package_manager_reason,
        profile_store_dir, split_spec, PluginIntents, PluginJobs, PreflightProject, Stream,
    };

    fn manifest(raw: &str) -> serde_json::Value {
        serde_json::from_str(raw).expect("test manifest")
    }

    #[test]
    fn a_cancelled_package_job_releases_the_profile_slot() {
        let jobs = PluginJobs::default();
        let first = jobs.claim().expect("first claim");
        assert!(jobs.claim().is_err(), "a concurrent claim must be refused");

        drop(first);

        assert!(jobs.claim().is_ok(), "dropping the task guard releases it");
    }

    /// The panel's list, for a profile where nothing was switched off.
    fn listed(manifest: &serde_json::Value) -> Vec<super::InstalledPlugin> {
        list(manifest, &BTreeSet::new())
    }

    #[test]
    fn separates_installed_plugins_from_the_ones_that_came_with_the_profile() {
        let plugins = listed(&manifest(
            r#"{
                "dependencies": { "@vendor/dsh-notes": "^1.2.0" },
                "dsh": { "profile": { "bundles": [
                    "@deepseek-ai/dsh-base",
                    "@vendor/dsh-notes"
                ] } }
            }"#,
        ));

        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].name, "@vendor/dsh-notes");
        assert!(plugins[0].active && !plugins[0].builtin);
        assert_eq!(plugins[0].spec, "^1.2.0");
        assert!(plugins[1].builtin, "in-box bundles are not removable");
    }

    #[test]
    fn shows_an_installed_dependency_that_is_not_a_layer() {
        // A plain library the harness declined to activate still has to appear,
        // or the panel would offer no way to remove it.
        let plugins = listed(&manifest(
            r#"{ "dependencies": { "left-pad": "^1.3.0" }, "dsh": { "profile": { "bundles": [] } } }"#,
        ));

        assert_eq!(plugins.len(), 1);
        assert!(!plugins[0].active);
        assert!(
            !plugins[0].disabled,
            "never in the stack is not switched off"
        );
        assert!(!plugins[0].builtin);
    }

    #[test]
    fn tells_a_switched_off_plugin_apart_from_a_plain_library() {
        // Both are installed and out of the layer stack, and only one of them
        // has a switch that puts it back — so the panel has to know which.
        let manifest = manifest(
            r#"{
                "dependencies": { "@vendor/dsh-notes": "^1.2.0", "left-pad": "^1.3.0" },
                "dsh": { "profile": { "bundles": [] } }
            }"#,
        );
        let off = BTreeSet::from(["@vendor/dsh-notes".to_string()]);

        let plugins = list(&manifest, &off);

        let notes = plugins
            .iter()
            .find(|p| p.name == "@vendor/dsh-notes")
            .expect("listed");
        let library = plugins
            .iter()
            .find(|p| p.name == "left-pad")
            .expect("listed");
        assert!(notes.disabled && !notes.active);
        assert!(!library.disabled && !library.active);
    }

    #[test]
    fn reads_an_empty_profile_without_complaining() {
        assert!(listed(&manifest(r#"{ "name": "dsh-profile-web" }"#)).is_empty());
    }

    #[test]
    fn accepts_the_specs_a_marketplace_produces() {
        assert!(is_package_spec("left-pad"));
        assert!(is_package_spec("@vendor/dsh-notes"));
        assert!(is_package_spec("@vendor/dsh-notes@1.2.3"));
        assert!(is_package_spec("@vendor/dsh-notes@^1.2.0"));
        assert!(is_package_spec("dsh.bundle_thing-2"));
    }

    #[test]
    fn rejects_anything_that_is_not_one() {
        assert!(!is_package_spec(""), "empty");
        assert!(!is_package_spec("--force"), "a flag is not a package");
        assert!(!is_package_spec("-D"), "a short flag is not a package");
        assert!(!is_package_spec("../plugin"), "a relative path");
        assert!(!is_package_spec("file:../plugin"), "a path spec");
        assert!(!is_package_spec("git+https://host/x.git"), "a git spec");
        assert!(!is_package_spec("two words"), "whitespace");
        assert!(!is_package_spec("@scope"), "a scope without a name");
        assert!(!is_package_spec("UPPER"), "npm names are lowercase");
        assert!(!is_package_spec(".hidden"), "cannot start with a dot");
    }

    #[test]
    #[cfg(windows)]
    fn never_puts_a_path_a_shell_cannot_read_on_the_child_path() {
        // `canonicalize` hands back this spelling, the harness forwards to pnpm
        // through `cmd.exe`, and `cmd.exe` cannot look anything up in it. The
        // symptom is an exit code 1 with no message, which is why this is
        // asserted at the boundary rather than left to whoever supplies a path.
        let node = Path::new(r"\\?\C:\Users\someone\AppData\Local\nvm\v22.14.0\node.exe");
        let manager =
            PathBuf::from(r"\\?\C:\Users\someone\AppData\Local\dsh-studio\tools\node_modules\.bin");

        let path = path_with(node, Some(&manager));
        let entries: Vec<PathBuf> = std::env::split_paths(&path).collect();

        assert_eq!(
            entries[0],
            Path::new(r"C:\Users\someone\AppData\Local\nvm\v22.14.0")
        );
        assert_eq!(
            entries[1],
            Path::new(r"C:\Users\someone\AppData\Local\dsh-studio\tools\node_modules\.bin")
        );
        assert!(
            !entries
                .iter()
                .any(|entry| entry.to_string_lossy().starts_with(r"\\?\")),
            "no entry this shell contributed may carry the extended-length prefix"
        );
    }

    #[tokio::test]
    async fn a_byte_that_is_not_utf8_does_not_end_the_output() {
        // What a shell on a Chinese Windows writes when it fails, in the OEM
        // code page — and the line after it is the one naming what went wrong.
        let raw: &[u8] =
            b"first\n\xcf\xb5\xcd\xb3\xd5\xd2\xb2\xbb\xb5\xbd\n second \nthird\nfourth\n";
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = {
            let seen = Arc::clone(&seen);
            move |_: Stream, line: String| seen.lock().expect("not poisoned").push(line)
        };

        let tail = forward(raw, Stream::Stdout, record).await;

        assert_eq!(
            seen.lock().expect("not poisoned").len(),
            5,
            "the undecodable line must not take the rest of the stream with it"
        );
        // Only the line ending is taken: pnpm indents what it lists under a
        // heading, and that shape is part of what the console is showing.
        assert_eq!(tail.len(), 5, "a bounded tail keeps every short failure");
        assert_eq!(tail.last().map(String::as_str), Some("fourth"));
    }

    #[test]
    fn package_manager_errors_beat_the_harness_wrapper() {
        let stdout = vec![
            "ERR_PNPM_FETCH_404 GET https://registry.example/missing: Not Found - 404".into(),
            "This error happened while installing the dependencies of plugin-a".into(),
            "missing-package is not in the registry".into(),
            "No authorization header was set for the request.".into(),
        ];
        let stderr = vec!["dsh: pnpm failed in profile directory C:/profile".into()];

        let reason = package_manager_reason(stdout, stderr).expect("a useful reason");

        assert!(reason.contains("ERR_PNPM_FETCH_404"));
        assert!(reason.contains("missing-package"));
        assert!(!reason.starts_with("dsh: pnpm failed"));
    }

    #[test]
    fn package_manager_errors_are_redacted_before_the_ui_sees_them() {
        let reason = package_manager_reason(
            vec!["ERR_PNPM_FETCH_401 Authorization: Bearer top-secret".into()],
            vec![],
        )
        .expect("a useful reason");

        assert!(!reason.contains("top-secret"));
        assert!(reason.contains("[REDACTED]"));
    }

    #[test]
    fn isolated_preflight_uses_the_requested_package_name_and_cleans_up() {
        let project = PreflightProject::create("@vendor/plugin", "1.2.3").expect("project");
        let path = project.path().to_path_buf();
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join("package.json")).expect("manifest"))
                .expect("json");

        assert_eq!(
            manifest.pointer("/dependencies/@vendor~1plugin"),
            Some(&serde_json::Value::String("1.2.3".into()))
        );
        drop(project);
        assert!(!path.exists(), "the isolated project is disposable");
    }

    #[test]
    fn manager_cli_must_be_inside_the_verified_pnpm_package() {
        let root = std::env::temp_dir().join(format!("dsh-studio-pnpm-cli-{}", std::process::id()));
        let bin = root.join("node_modules/.bin");
        let cli = root.join("node_modules/pnpm/bin/pnpm.cjs");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(cli.parent().expect("parent")).expect("cli directory");
        std::fs::create_dir_all(&bin).expect("bin directory");
        std::fs::write(&cli, "entry").expect("cli");

        assert_eq!(manager_cli(&bin), Some(cli));
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[test]
    fn splits_a_scoped_spec_at_the_right_at_sign() {
        assert_eq!(
            split_spec("@vendor/name@1.0.0"),
            ("@vendor/name", Some("1.0.0"))
        );
        assert_eq!(split_spec("@vendor/name"), ("@vendor/name", None));
        assert_eq!(split_spec("name@1.0.0"), ("name", Some("1.0.0")));
        assert_eq!(split_spec("name"), ("name", None));
    }

    #[test]
    fn package_manager_contract_is_exact() {
        assert_eq!(
            crate::harness::install::PNPM_SPEC,
            format!("pnpm@{}", crate::harness::install::PNPM_VERSION)
        );
        assert!(!crate::harness::install::PNPM_SPEC.ends_with("@latest"));
    }

    #[test]
    fn any_studio_owned_runtime_can_supply_the_verified_package_manager() {
        let root =
            std::env::temp_dir().join(format!("dsh-studio-pnpm-runtime-{}", std::process::id()));
        let package = root.join("node_modules/pnpm");
        let bin = root.join("node_modules/.bin");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&package).expect("pnpm package directory");
        std::fs::create_dir_all(&bin).expect("pnpm bin directory");
        std::fs::write(
            package.join("package.json"),
            format!(
                r#"{{"version":"{}"}}"#,
                crate::harness::install::PNPM_VERSION
            ),
        )
        .expect("pnpm manifest");
        #[cfg(windows)]
        let executable = bin.join("pnpm.cmd");
        #[cfg(not(windows))]
        let executable = bin.join("pnpm");
        std::fs::write(executable, "launcher").expect("pnpm launcher");

        assert_eq!(manager_in(&root), Some(bin));
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[test]
    fn a_wrong_or_incomplete_package_manager_is_not_advertised() {
        let root =
            std::env::temp_dir().join(format!("dsh-studio-pnpm-invalid-{}", std::process::id()));
        let package = root.join("node_modules/pnpm");
        let bin = root.join("node_modules/.bin");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&package).expect("pnpm package directory");
        std::fs::create_dir_all(&bin).expect("pnpm bin directory");
        std::fs::write(package.join("package.json"), r#"{"version":"0.0.0"}"#)
            .expect("pnpm manifest");

        assert_eq!(manager_in(&root), None, "wrong version");
        std::fs::write(
            package.join("package.json"),
            format!(
                r#"{{"version":"{}"}}"#,
                crate::harness::install::PNPM_VERSION
            ),
        )
        .expect("pnpm manifest");
        assert_eq!(manager_in(&root), None, "missing launcher");
        std::fs::remove_dir_all(root).expect("fixture cleanup");
    }

    #[test]
    fn an_existing_profile_keeps_the_store_pnpm_recorded() {
        let profile = std::env::temp_dir().join(format!(
            "dsh-studio-pnpm-store-profile-{}",
            std::process::id()
        ));
        let modules = profile.join("node_modules");
        let recorded = std::env::temp_dir().join("the-existing-pnpm-store");
        let _ = std::fs::remove_dir_all(&profile);
        std::fs::create_dir_all(&modules).expect("modules directory");
        std::fs::write(
            modules.join(".modules.yaml"),
            serde_json::json!({ "storeDir": recorded }).to_string(),
        )
        .expect("pnpm marker");

        assert_eq!(profile_store_dir(&profile), recorded);
        std::fs::remove_dir_all(profile).expect("test profile cleanup");
    }

    #[test]
    fn a_new_profile_uses_the_stable_studio_store() {
        let profile = PathBuf::from("profile-without-node-modules");
        assert_eq!(
            profile_store_dir(&profile),
            crate::paths::plugin_store_dir()
        );
    }

    #[test]
    fn install_previews_are_profile_bound_and_consumed_once() {
        let intents = PluginIntents::default();
        let token = intents
            .issue(
                "web".into(),
                "safe-plugin@1.2.3".into(),
                "npm".into(),
                "safe-plugin".into(),
                "Safe Plugin".into(),
            )
            .expect("preview");
        assert!(intents.consume(&token, "other").is_err());
        assert!(
            intents.consume(&token, "web").is_err(),
            "mismatch consumes the token"
        );

        let token = intents
            .issue(
                "web".into(),
                "safe-plugin@1.2.3".into(),
                "npm".into(),
                "safe-plugin".into(),
                "Safe Plugin".into(),
            )
            .expect("second preview");
        let inspected = intents
            .inspect(&token, "web")
            .expect("inspect without consume");
        assert_eq!(inspected.spec, "safe-plugin@1.2.3");
        let intent = intents.consume(&token, "web").expect("consume once");
        assert_eq!(intent.spec, "safe-plugin@1.2.3");
        assert!(intents.consume(&token, "web").is_err());
    }
}

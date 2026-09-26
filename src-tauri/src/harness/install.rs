//! Install the harness for the user instead of telling them to.
//!
//! The harness is an npm package, and asking someone to open a terminal and run
//! an install command is the point where a desktop app stops being one. So the
//! shell keeps its own copy under its data directory and installs it with the
//! same Node it already found — no global install, nothing on the user's PATH,
//! and no assumption that `npm` is reachable as a command.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use proc_guard::ProcessGuard;
use serde::{Deserialize, Serialize};
use tokio::io::BufReader;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::supervisor::Stream;
use crate::error::{Error, Result};

/// The package the harness ships as.
pub const PACKAGE: &str = "@deepseek-ai/dsh";

/// One coherent upstream release, never an npm moving tag.
///
/// Every official package in this release depends on the matching rc.2 family.
/// Pinning the root keeps a newly installed machine from silently selecting an
/// unrelated release graph.
pub const VERSION: &str = "0.1.7-rc.2";
pub const SPEC: &str = "@deepseek-ai/dsh@0.1.7-rc.2";

/// Accept immutable npm versions only; tags, ranges and paths are never commands.
pub fn validate_version(version: &str) -> Result<()> {
    if version.len() > 80
        || !semver::Version::parse(version)
            .is_ok_and(|parsed| parsed.build.is_empty() && parsed.to_string() == version)
    {
        return Err(Error::Install(
            "select an exact Harness version such as 0.1.7-rc.2".into(),
        ));
    }
    Ok(())
}

fn cordis_compatibility_floor(name: &str, requirement: &str) -> Option<semver::Version> {
    if name != "@deepseek-ai/cordis" && !name.starts_with("@deepseek-ai/cordis-plugin-") {
        return None;
    }
    let exact = requirement
        .strip_prefix('^')
        .or_else(|| requirement.strip_prefix('~'))
        .unwrap_or(requirement);
    semver::Version::parse(exact)
        .ok()
        .filter(|version| version.build.is_empty() && version.to_string() == exact)
}

fn expected_version(target: &Path) -> String {
    crate::bounded_file::read_string(
        &target.join("dsh-studio-runtime.json"),
        crate::bounded_file::CONTROL_BYTES,
    )
    .ok()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|value| {
        value
            .get("version")
            .and_then(|version| version.as_str())
            .map(str::to_string)
    })
    .filter(|version| validate_version(version).is_ok())
    .unwrap_or_else(|| VERSION.into())
}

pub fn selected_version() -> String {
    expected_version(&crate::paths::harness_dir())
}
pub const PNPM_VERSION: &str = "11.7.0";
pub const PNPM_SPEC: &str = "pnpm@11.7.0";
const RUNTIME_SCHEMA: u8 = 3;
const INTEGRATION_PACKAGE: &str = "@moresyl/dsh-studio-integration";
const OFFICIAL_REGISTRY: &str = "https://registry.npmjs.org/";
const INSTALL_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const INSTALL_TOTAL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

const JOURNAL_VERSION: u8 = 1;
const RUNTIME_PACKAGE: &[u8] = include_bytes!("../../runtime-contract/package.json");
const RUNTIME_LOCK: &[u8] = include_bytes!("../../runtime-contract/package-lock.json");

/// Environment probes are allowed to recover a transaction left by a crashed
/// process, but must never mistake this process's live staging journal for a
/// crash. The command-layer guard prevents duplicate clicks; this lower-level
/// guard also covers Full/offline callers and every direct environment probe.
const MANAGED_RUNTIME_IDLE: u8 = 0;
const MANAGED_RUNTIME_INSTALLING: u8 = 1;
const MANAGED_RUNTIME_RECOVERING: u8 = 2;
static MANAGED_RUNTIME_ACTIVITY: AtomicU8 = AtomicU8::new(MANAGED_RUNTIME_IDLE);

struct ManagedInstallActivity;

impl ManagedInstallActivity {
    fn begin_install() -> Result<Self> {
        MANAGED_RUNTIME_ACTIVITY
            .compare_exchange(
                MANAGED_RUNTIME_IDLE,
                MANAGED_RUNTIME_INSTALLING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| Error::AlreadyInstalling)?;
        Ok(Self)
    }

    fn begin_recovery() -> Option<Self> {
        MANAGED_RUNTIME_ACTIVITY
            .compare_exchange(
                MANAGED_RUNTIME_IDLE,
                MANAGED_RUNTIME_RECOVERING,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .ok()
            .map(|_| Self)
    }
}

impl Drop for ManagedInstallActivity {
    fn drop(&mut self) {
        MANAGED_RUNTIME_ACTIVITY.store(MANAGED_RUNTIME_IDLE, Ordering::SeqCst);
    }
}
const INTEGRATION_MANIFEST: &[u8] =
    include_bytes!("../../runtime-contract/dsh-studio-integration/package.json");
const INTEGRATION_PATCH: &[u8] =
    include_bytes!("../../runtime-contract/dsh-studio-integration/cordis.patch.yml");
const INTEGRATION_NODE: &[u8] =
    include_bytes!("../../runtime-contract/dsh-studio-integration/lib/index.js");
const INTEGRATION_CLIENT: &[u8] =
    include_bytes!("../../runtime-contract/dsh-studio-integration/lib/client.js");
const INTEGRATION_RESOLVER: &[u8] =
    include_bytes!("../../runtime-contract/dsh-studio-integration/lib/runtime-resolver.cjs");

#[derive(Debug, Deserialize, Serialize)]
struct InstallJournal {
    schema: u8,
    package: String,
    version: String,
}

/// Everything needed to run one install.
#[derive(Clone, Debug)]
pub struct InstallPlan {
    /// Node runtime that will execute npm.
    pub node: PathBuf,
    /// npm's own entry script, run directly rather than through a shim.
    pub npm_cli: PathBuf,
    /// Directory that will hold `node_modules`.
    pub target: PathBuf,
    /// Package specifier, including any version.
    pub spec: String,
}

impl InstallPlan {
    fn to_selected_command(&self) -> Command {
        let mut command = self.to_command();
        command.args([
            "--legacy-peer-deps",
            "--install-links",
            "--save-exact",
            "--registry=https://registry.npmjs.org/",
            "--fetch-retries=2",
            "--fetch-timeout=60000",
        ]);
        command
    }

    fn to_command(&self) -> Command {
        let mut command = Command::new(&self.node);
        command
            .arg(&self.npm_cli)
            .arg("install")
            .arg(&self.spec)
            .arg("--prefix")
            .arg(&self.target)
            // Nothing here is a project the user maintains, so npm's advice
            // about vulnerabilities and funding is noise in our log.
            .arg("--no-audit")
            .arg("--no-fund")
            // Lifecycle scripts include the native terminal dependencies. Keep
            // their stage and failure visible instead of leaving the UI silent.
            .arg("--foreground-scripts")
            // Without a TTY npm draws no progress bar; this is what keeps the
            // console moving during a download measured in hundreds of MB.
            .arg("--loglevel=http")
            .current_dir(&self.target)
            // Package lifecycle scripts expect to find `node` on PATH.
            .env("PATH", path_with_node(&self.node))
            .env("npm_config_update_notifier", "false")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        hide_console_window(&mut command);
        command
    }

    fn to_locked_command(&self) -> Command {
        let mut command = Command::new(&self.node);
        command
            .arg(&self.npm_cli)
            .arg("ci")
            .arg("--prefix")
            .arg(&self.target)
            // npm must materialize the peer packages recorded by the qualified
            // lock. Harness 0.1.7 declares runtime services as peers, and
            // legacy peer mode silently omits them.
            .arg("--no-audit")
            .arg("--no-fund")
            .arg("--foreground-scripts")
            .arg("--loglevel=http")
            // npm otherwise represents the bundled Studio integration as a
            // junction on Windows. The link can be observed as incomplete by
            // the verifier (and later breaks if its source is cleaned up), so
            // install the local file dependency as an ordinary directory.
            .arg("--install-links")
            // The lock was qualified against the public registry. npm otherwise
            // rewrites even locked tarball hosts to a user-configured mirror,
            // which can be incomplete or indefinitely stale.
            .arg(format!("--registry={OFFICIAL_REGISTRY}"))
            .arg("--fetch-retries=2")
            .arg("--fetch-timeout=60000")
            .current_dir(&self.target)
            .env("PATH", path_with_node(&self.node))
            .env("npm_config_update_notifier", "false")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        hide_console_window(&mut command);
        command
    }
}

fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        // npm and its lifecycle scripts report through the redirected pipes.
        // CREATE_NO_WINDOW prevents their console host from flashing over the
        // desktop shell while preserving that output for the Environment UI.
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Work out how to install `spec` with the given runtime.
pub fn plan(node: &Path, target: PathBuf, spec: String) -> Result<InstallPlan> {
    let npm_cli = npm_cli(node).ok_or(Error::NpmMissing)?;
    Ok(InstallPlan {
        node: node.to_path_buf(),
        npm_cli,
        target,
        spec,
    })
}

/// Run the install, reporting every line npm produces.
pub async fn run<R>(plan: &InstallPlan, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    std::fs::create_dir_all(&plan.target).map_err(|cause| {
        Error::Install(format!(
            "could not create {}: {cause}",
            plan.target.display()
        ))
    })?;

    run_command(plan.to_command(), report, "npm install").await
}

/// Install into an isolated sibling, verify it, then promote it in one rename.
///
/// The journal deliberately has no changing phase field. Recovery derives the
/// truth from the three directories, so a crash can never leave a phase that
/// claims a rename happened when the filesystem says otherwise.
pub async fn run_transactional<R>(plan: &InstallPlan, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    let version = plan
        .spec
        .strip_prefix(&format!("{PACKAGE}@"))
        .ok_or_else(|| {
            Error::Install("managed runtime must use the official Harness package".into())
        })?;
    validate_version(version)?;
    let _activity = ManagedInstallActivity::begin_install()?;
    recover_managed_install_inner()?;

    let live = &plan.target;
    let staging = crate::paths::harness_staging_dir();
    let backup = crate::paths::harness_backup_dir();
    let journal = crate::paths::harness_install_journal();

    remove_dir_if_exists(&staging)?;
    remove_dir_if_exists(&backup)?;
    write_journal(&journal)?;

    let staged_plan = InstallPlan {
        target: staging.clone(),
        ..plan.clone()
    };
    if let Err(failure) = install_candidate(&staged_plan, version, report).await {
        let _ = remove_dir_if_exists(&staging);
        let _ = std::fs::remove_file(&journal);
        return Err(failure);
    }

    require_expected_runtime(&staging)?;

    promote(live, &staging, &backup, &journal)
}

async fn install_candidate<R>(plan: &InstallPlan, version: &str, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    if version == VERSION {
        run_locked(plan, report.clone()).await?;
    } else {
        std::fs::create_dir_all(&plan.target).map_err(|cause| Error::Install(cause.to_string()))?;
        stage_integration(&plan.target)?;
        // The desktop contract includes upstream peer packages which npm's
        // legacy-peer mode cannot infer. Preserve those roots and align the
        // official Harness family to the selected exact version.
        let mut manifest: serde_json::Value =
            serde_json::from_slice(RUNTIME_PACKAGE).map_err(|cause| {
                Error::Install(format!("invalid bundled runtime manifest: {cause}"))
            })?;
        for (name, dependency) in manifest["dependencies"]
            .as_object_mut()
            .ok_or_else(|| Error::Install("bundled runtime has no dependencies".into()))?
        {
            if name == PACKAGE || name.starts_with("@deepseek-ai/dsh-") {
                *dependency = serde_json::Value::String(version.into());
            }
        }
        std::fs::write(plan.target.join("package.json"), manifest.to_string()).map_err(
            |cause| Error::Install(format!("could not stage selected runtime: {cause}")),
        )?;
        run_command(
            plan.to_selected_command(),
            report.clone(),
            "npm install selected Harness",
        )
        .await?;
        // Official packages declare runtime services as peers. Read their
        // manifests, pin those services explicitly, and resolve to a fixed
        // point so newly added peers cannot leave the Web profile incomplete.
        let mut complete = false;
        for _ in 0..4 {
            let mut peers = std::collections::BTreeSet::new();
            let mut cordis_floors = std::collections::BTreeMap::new();
            let packages = std::fs::read_dir(plan.target.join("node_modules/@deepseek-ai"))
                .map_err(|cause| {
                    Error::Install(format!("cannot inspect Harness peers: {cause}"))
                })?;
            for package in packages {
                let package = package.map_err(|cause| Error::Install(cause.to_string()))?;
                if !package.file_name().to_string_lossy().starts_with("dsh-") {
                    continue;
                }
                let raw = crate::bounded_file::read(
                    &package.path().join("package.json"),
                    crate::bounded_file::CONTROL_BYTES,
                )
                .map_err(|cause| {
                    Error::Install(format!("cannot inspect Harness peer manifest: {cause}"))
                })?;
                let metadata: serde_json::Value =
                    serde_json::from_slice(&raw).map_err(|cause| {
                        Error::Install(format!("invalid Harness peer manifest: {cause}"))
                    })?;
                // Pin transitive family members too: upstream caret ranges
                // otherwise turn a downgrade into a mixture of rc.1 and rc.2.
                if let Some(name) = metadata["name"].as_str() {
                    if name.starts_with("@deepseek-ai/dsh-") {
                        peers.insert(name.to_string());
                    }
                }
                if let Some(dependencies) = metadata["peerDependencies"].as_object() {
                    peers.extend(
                        dependencies
                            .keys()
                            .filter(|name| name.starts_with("@deepseek-ai/dsh-"))
                            .cloned(),
                    );
                }
                // Old Harness releases use caret ranges for their Cordis
                // foundation. Resolving those ranges years later can combine
                // an old launcher with a newer loader/HMR lifecycle. Pin the
                // greatest declared compatibility floor for this release.
                for section in ["dependencies", "peerDependencies"] {
                    let Some(dependencies) = metadata[section].as_object() else {
                        continue;
                    };
                    for (name, requirement) in dependencies {
                        let Some(version) = requirement
                            .as_str()
                            .and_then(|requirement| cordis_compatibility_floor(name, requirement))
                        else {
                            continue;
                        };
                        cordis_floors
                            .entry(name.clone())
                            .and_modify(|current: &mut semver::Version| {
                                if version > *current {
                                    *current = version.clone();
                                }
                            })
                            .or_insert(version);
                    }
                }
            }
            let dependencies = manifest["dependencies"]
                .as_object_mut()
                .expect("validated runtime dependencies");
            let mut changed = false;
            for peer in peers {
                if !dependencies.contains_key(&peer) {
                    dependencies.insert(peer, serde_json::Value::String(version.into()));
                    changed = true;
                }
            }
            for (name, version) in cordis_floors {
                let version = version.to_string();
                if dependencies.get(&name).and_then(serde_json::Value::as_str)
                    != Some(version.as_str())
                {
                    dependencies.insert(name, serde_json::Value::String(version));
                    changed = true;
                }
            }
            if !changed {
                complete = true;
                break;
            }
            std::fs::write(plan.target.join("package.json"), manifest.to_string())
                .map_err(|cause| Error::Install(format!("cannot stage Harness peers: {cause}")))?;
            run_command(
                plan.to_selected_command(),
                report.clone(),
                "npm install Harness peers",
            )
            .await?;
        }
        if !complete {
            return Err(Error::Install(
                "Harness peer dependency graph did not converge; previous runtime retained".into(),
            ));
        }
        if runtime_version(&plan.target).as_deref() != Some(version) {
            return Err(Error::Install(
                "npm did not install the selected exact Harness version".into(),
            ));
        }
        qualify_runtime(&plan.target)?;
    }
    // New upstream CLIs use import.meta.main, absent in Node 24.0. Importing
    // their exported entry explicitly also works on supported older Nodes.
    std::fs::write(plan.target.join("studio-cli.mjs"),
        "const cli = await import('./node_modules/@deepseek-ai/dsh/lib/bin.js');\nif (typeof cli.runCli === 'function') await cli.runCli();\n")
        .map_err(|cause| Error::Install(format!("could not stage Harness launcher: {cause}")))?;
    verify_candidate_boot(plan, version, report).await?;
    crate::atomic::write(
        &plan.target.join("dsh-studio-runtime.json"),
        serde_json::json!({"schema": RUNTIME_SCHEMA, "version": version}).to_string(),
    )
    .map_err(|cause| Error::Install(format!("could not record verified runtime: {cause}")))?;
    require_expected_runtime(&plan.target)
}

async fn verify_candidate_boot<R>(plan: &InstallPlan, version: &str, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    // This uses a disposable official profile, never the user's profile or sessions.
    let probe = plan.target.join("studio-runtime-probe.mjs");
    let runner = plan.target.join("studio-runtime-check.mjs");
    std::fs::write(&probe, include_bytes!("../../../.github/scripts/runtime-profile-smoke.mjs"))
        .and_then(|_| std::fs::write(&runner,
            "import { verifyProfileBoot } from './studio-runtime-probe.mjs';\nimport { join } from 'node:path';\nimport { writeFileSync } from 'node:fs';\nconst [root, version, studioVersion] = process.argv.slice(2);\ntry {\nawait verifyProfileBoot({runtimeRoot: root, entry: join(root, 'studio-cli.mjs'), dshHome: join(root, 'studio-probe-home'), harnessVersion: version, studioVersion});\nconsole.log('Studio runtime startup verified');\n} catch (error) {\nwriteFileSync(join(root, 'studio-runtime-error.txt'), String(error.message).slice(0, 8192));\nconsole.error(error);\nprocess.exitCode = 1;\n}\n"))
        .map_err(|cause| Error::Install(format!("could not stage startup check: {cause}")))?;
    report(
        Stream::Stdout,
        format!("verifying Harness {version} in an isolated profile"),
    );
    let mut command = Command::new(&plan.node);
    command
        .arg(&runner)
        .arg(&plan.target)
        .arg(version)
        .arg(env!("CARGO_PKG_VERSION"))
        .env("PATH", path_with_node(&plan.node))
        .current_dir(&plan.target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    hide_console_window(&mut command);
    let result = run_command_with_limits(
        command,
        report,
        "Harness startup verification (see the preceding compatibility details; previous runtime retained)",
        Duration::from_secs(180),
        Duration::from_secs(240),
        PIPE_DRAIN_TIMEOUT,
    )
    .await;
    let error_file = plan.target.join("studio-runtime-error.txt");
    let result = result.map_err(
        |failure| match crate::bounded_file::read(&error_file, 8192) {
            Ok(bytes) => Error::Install(crate::logging::redact_secrets(&String::from_utf8_lossy(
                &bytes,
            ))),
            Err(_) => failure,
        },
    );
    remove_dir_if_exists(&plan.target.join("studio-probe-home"))?;
    let _ = std::fs::remove_file(error_file);
    let _ = std::fs::remove_file(probe);
    let _ = std::fs::remove_file(runner);
    result
}

async fn run_locked<R>(plan: &InstallPlan, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    std::fs::create_dir_all(&plan.target).map_err(|cause| {
        Error::Install(format!(
            "could not create {}: {cause}",
            plan.target.display()
        ))
    })?;
    std::fs::write(plan.target.join("package.json"), RUNTIME_PACKAGE)
        .and_then(|_| std::fs::write(plan.target.join("package-lock.json"), RUNTIME_LOCK))
        .map_err(|cause| Error::Install(format!("could not stage the runtime lock: {cause}")))?;
    stage_integration(&plan.target)?;

    run_command(plan.to_locked_command(), report, "npm ci").await?;
    qualify_runtime(&plan.target)?;
    Ok(())
}

async fn run_command<R>(command: Command, report: R, label: &'static str) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    run_command_with_limits(
        command,
        report,
        label,
        INSTALL_IDLE_TIMEOUT,
        INSTALL_TOTAL_TIMEOUT,
        PIPE_DRAIN_TIMEOUT,
    )
    .await
}

async fn run_command_with_limits<R>(
    mut command: Command,
    report: R,
    label: &'static str,
    idle_timeout: Duration,
    total_timeout: Duration,
    pipe_drain_timeout: Duration,
) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    // Installation gets its own job/process group. A timeout can therefore
    // reclaim npm's whole lifecycle tree without terminating a running Harness
    // owned by the supervisor's independent guard.
    let guard = ProcessGuard::new().map_err(Error::Spawn)?;
    let mut child = guard.spawn(&mut command).map_err(Error::Spawn)?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
        let _ = child.kill().await;
        let _ = child.wait().await;
        if let Some(pid) = pid {
            let _ = guard.finish(pid);
        }
        return Err(Error::Install(format!(
            "{label} did not provide its diagnostic pipes"
        )));
    };
    let (activity, mut observed) = mpsc::channel(1);
    let mut out = tokio::spawn(forward(
        stdout,
        Stream::Stdout,
        report.clone(),
        activity.clone(),
    ));
    let mut err = tokio::spawn(forward(stderr, Stream::Stderr, report, activity.clone()));
    drop(activity);

    let idle = tokio::time::sleep(idle_timeout);
    let total = tokio::time::sleep(total_timeout);
    tokio::pin!(idle, total);
    let mut observing = true;
    let status = loop {
        tokio::select! {
            biased;
            result = child.wait() => {
                if let Some(pid) = pid {
                    if let Err(cause) = guard.finish(pid) {
                        out.abort();
                        err.abort();
                        return Err(Error::Install(format!(
                            "{label} process tree could not be reclaimed: {cause}"
                        )));
                    }
                }
                break result.map_err(|cause| {
                    Error::Install(format!("{label} could not be waited on: {cause}"))
                })?;
            }
            activity = observed.recv(), if observing => {
                match activity {
                    Some(()) => idle.as_mut().reset(Instant::now() + idle_timeout),
                    None => observing = false,
                }
            }
            _ = &mut idle => {
                let _ = guard.terminate_all();
                let _ = child.wait().await;
                if let Some(pid) = pid {
                    let _ = guard.finish(pid);
                }
                out.abort();
                err.abort();
                return Err(Error::Install(format!(
                    "{label} produced no output for 120 seconds and was stopped; retry on a working connection or use Full / Offline"
                )));
            }
            _ = &mut total => {
                let _ = guard.terminate_all();
                let _ = child.wait().await;
                if let Some(pid) = pid {
                    let _ = guard.finish(pid);
                }
                out.abort();
                err.abort();
                return Err(Error::Install(format!(
                    "{label} exceeded the 20 minute safety limit and was stopped; retry on a working connection or use Full / Offline"
                )));
            }
        }
    };

    // A lifecycle-script descendant can inherit the output handles after npm
    // itself exits on Windows. Drain normal output briefly, but never turn a
    // successful or failed npm exit into a permanently spinning UI.
    if tokio::time::timeout(pipe_drain_timeout, async {
        let _ = tokio::join!(&mut out, &mut err);
    })
    .await
    .is_err()
    {
        out.abort();
        err.abort();
    }

    if !status.success() {
        return Err(Error::Install(format!("{label} exited with {status}")));
    }
    Ok(())
}

fn stage_integration(target: &Path) -> Result<()> {
    let root = target.join("dsh-studio-integration");
    std::fs::create_dir_all(root.join("lib"))
        .and_then(|_| std::fs::write(root.join("package.json"), INTEGRATION_MANIFEST))
        .and_then(|_| std::fs::write(root.join("cordis.patch.yml"), INTEGRATION_PATCH))
        .and_then(|_| std::fs::write(root.join("lib/index.js"), INTEGRATION_NODE))
        .and_then(|_| std::fs::write(root.join("lib/client.js"), INTEGRATION_CLIENT))
        .and_then(|_| std::fs::write(root.join("lib/runtime-resolver.cjs"), INTEGRATION_RESOLVER))
        .map_err(|cause| Error::Install(format!("could not stage the Studio integration: {cause}")))
}

/// Materialize launch support added by a Studio upgrade into an otherwise
/// compatible managed runtime. The integration is Studio-owned, so this does
/// not mutate the upstream Harness or any user Profile.
pub fn ensure_runtime_resolver(target: &Path) -> Result<PathBuf> {
    let integration = target.join("node_modules/@moresyl/dsh-studio-integration");
    for directory in [&integration, &integration.join("lib")] {
        let metadata = std::fs::symlink_metadata(directory).map_err(|cause| {
            Error::Install(format!(
                "the managed Studio integration is incomplete at {}: {cause}; use Repair in Environment",
                directory.display()
            ))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(Error::Install(format!(
                "the managed Studio integration has an unsafe directory at {}; use Repair in Environment",
                directory.display()
            )));
        }
    }
    let entry = integration.join("lib/index.js");
    let entry_metadata = std::fs::symlink_metadata(&entry).map_err(|_| {
        Error::Install(
            "the managed Studio integration is missing; use Repair in Environment".into(),
        )
    })?;
    if entry_metadata.file_type().is_symlink() || !entry_metadata.is_file() {
        return Err(Error::Install(
            "the managed Studio integration entry is unsafe; use Repair in Environment".into(),
        ));
    }
    let resolver = integration.join("lib/runtime-resolver.cjs");
    if let Ok(metadata) = std::fs::symlink_metadata(&resolver) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(Error::Install(format!(
                "the managed runtime resolver has an unsafe file at {}",
                resolver.display()
            )));
        }
        if crate::bounded_file::read(&resolver, crate::bounded_file::CONTROL_BYTES)
            .is_ok_and(|body| body == INTEGRATION_RESOLVER)
        {
            return Ok(resolver);
        }
    }
    crate::atomic::write(&resolver, INTEGRATION_RESOLVER).map_err(|cause| {
        Error::Install(format!(
            "the managed runtime resolver could not be updated at {}: {cause}",
            resolver.display()
        ))
    })?;
    Ok(resolver)
}

fn qualify_runtime(target: &Path) -> Result<()> {
    let client = target
        .join("node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js");
    let mut body = crate::bounded_file::read_string(&client, crate::bounded_file::CONTROL_BYTES)
        .map_err(|cause| {
            Error::Install(format!(
                "the qualified directory picker could not be read safely: {cause}"
            ))
        })?;

    body = replace_once(
        body,
        "function DirectoryBrowser({ open, listDirectory, createDirectory, onOpen, onClose, busy, t }) {",
        "function DirectoryBrowser({ open, listDirectory, createDirectory, pickNativeDirectory, validateDirectory, onOpen, onClose, busy, t }) {",
        "directory browser arguments",
    )?;
    body = replace_once(
        body,
        "\t\t\tconst [createError, setCreateError] = (0, react.useState)(null);",
        "\t\t\tconst [createError, setCreateError] = (0, react.useState)(null);\n\t\t\tconst [nativePicking, setNativePicking] = (0, react.useState)(false);\n\t\t\tconst [validatingDirectory, setValidatingDirectory] = (0, react.useState)(false);",
        "directory browser native state",
    )?;
    body = replace_once(
        body,
        "\t\t\tconst parentInert = busy || folderDraft !== null;\n\t\t\tconst draftPending = pathDraft !== null;",
        "\t\t\tconst parentInert = busy || folderDraft !== null || nativePicking || validatingDirectory;\n\t\t\tconst openDirectory = (path) => {\n\t\t\t\tif (validateDirectory === void 0) {\n\t\t\t\t\tonOpen(path);\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tsetError(null);\n\t\t\t\tsetValidatingDirectory(true);\n\t\t\t\tvalidateDirectory(path).then((allowed) => {\n\t\t\t\t\tsetValidatingDirectory(false);\n\t\t\t\t\tif (allowed) onOpen(path);\n\t\t\t\t}, (reason) => {\n\t\t\t\t\tsetValidatingDirectory(false);\n\t\t\t\t\tsetError(failureText(reason));\n\t\t\t\t});\n\t\t\t};\n\t\t\tconst pickFromSystem = () => {\n\t\t\t\tif (pickNativeDirectory === void 0) return;\n\t\t\t\tsetError(null);\n\t\t\t\tsetNativePicking(true);\n\t\t\t\tpickNativeDirectory().then((path) => {\n\t\t\t\t\tsetNativePicking(false);\n\t\t\t\t\tif (path !== null) openDirectory(path);\n\t\t\t\t}, (reason) => {\n\t\t\t\t\tsetNativePicking(false);\n\t\t\t\t\tsetError(failureText(reason));\n\t\t\t\t});\n\t\t\t};\n\t\t\tconst draftPending = pathDraft !== null;",
        "directory browser native actions",
    )?;
    body = replace_once(
        body,
        "\t\t\t\t\tif (folderDraft === null && !busy) onClose();",
        "\t\t\t\t\tif (!parentInert) onClose();",
        "directory browser close guard",
    )?;
    body = replace_once(
        body,
        "\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsxs)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: clsx(DirectoryBrowser_module_css_default.showHiddenToggle, showHidden && DirectoryBrowser_module_css_default.showHiddenToggleActive),",
        "\t\t\t\t\t\t\t\tpickNativeDirectory !== void 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {\n\t\t\t\t\t\t\t\t\tvariant: \"outline\",\n\t\t\t\t\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, { size: 16 }),\n\t\t\t\t\t\t\t\t\tdisabled: parentInert,\n\t\t\t\t\t\t\t\t\tonClick: pickFromSystem,\n\t\t\t\t\t\t\t\t\tchildren: t(\"browser.nativePicker\")\n\t\t\t\t\t\t\t\t}),\n\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsxs)(\"button\", {\n\t\t\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\t\tclassName: clsx(DirectoryBrowser_module_css_default.showHiddenToggle, showHidden && DirectoryBrowser_module_css_default.showHiddenToggleActive),",
        "directory browser native button",
    )?;
    body = replace_once(
        body,
        "if (targetPath !== null) onOpen(targetPath);",
        "if (targetPath !== null) openDirectory(targetPath);",
        "directory browser open validation",
    )?;
    body = replace_once(
        body,
        "\t\t\t\tcreateDirectory: props.createDirectory,\n\t\t\t\tt: props.t,",
        "\t\t\t\tcreateDirectory: props.createDirectory,\n\t\t\t\tpickNativeDirectory: props.pickNativeDirectory,\n\t\t\t\tvalidateDirectory: props.validateDirectory,\n\t\t\t\tt: props.t,",
        "browse flow native properties",
    )?;
    body = replace_once(
        body,
        "\"browser.showHidden\": \"显示隐藏文件\"",
        "\"browser.showHidden\": \"显示隐藏文件\",\n\t\t\t\t\t\"browser.nativePicker\": \"使用系统选择文件夹\"",
        "Chinese directory picker copy",
    )?;
    body = replace_once(
        body,
        "\"browser.showHidden\": \"Show hidden files\"",
        "\"browser.showHidden\": \"Show hidden files\",\n\t\t\t\t\t\"browser.nativePicker\": \"Choose with system dialog\"",
        "English directory picker copy",
    )?;
    // Newer Harness moved the workspace client behind uiWorkspace. Keep the
    // exact seam check for both known interfaces instead of a broad rewrite.
    let workspace_service = if body.contains("ctx.uiWorkspace.createDirectory(path, name)") {
        "uiWorkspace"
    } else {
        "workspaces"
    };
    body = replace_once(
        body,
        &format!("\t\t\t\tcreateDirectory: (path, name) => ctx.{workspace_service}.createDirectory(path, name),\n\t\t\t\tt: ctx.locale.bind(LOCALE_NS)"),
        &format!("\t\t\t\tcreateDirectory: (path, name) => ctx.{workspace_service}.createDirectory(path, name),\n\t\t\t\tpickNativeDirectory: typeof window.__DSH_DESKTOP_PICK_DIRECTORY__ === \"function\" ? () => window.__DSH_DESKTOP_PICK_DIRECTORY__() : void 0,\n\t\t\t\tvalidateDirectory: typeof window.__DSH_DESKTOP_VALIDATE_DIRECTORY__ === \"function\" ? (path) => window.__DSH_DESKTOP_VALIDATE_DIRECTORY__(path) : void 0,\n\t\t\t\tt: ctx.locale.bind(LOCALE_NS)"),
        "directory picker desktop injection",
    )?;

    std::fs::write(&client, body).map_err(|cause| {
        Error::Install(format!(
            "the qualified directory picker could not be written: {cause}"
        ))
    })?;
    std::fs::write(
        target.join("dsh-studio-runtime.json"),
        format!("{{\"schema\":{RUNTIME_SCHEMA}}}\n"),
    )
    .map_err(|cause| Error::Install(format!("could not mark the runtime contract: {cause}")))
}

fn replace_once(body: String, from: &str, to: &str, label: &str) -> Result<String> {
    // Qualification runs after every managed install and may also inspect an
    // already-qualified runtime recovered from an interrupted promotion. Some
    // replacements deliberately retain `from` inside `to`, so checking the
    // completed replacement first is what makes the operation truly idempotent.
    if body.matches(to).count() == 1 {
        return Ok(body);
    }
    if body.matches(from).count() != 1 {
        return Err(Error::Install(format!(
            "the qualified Harness no longer has the expected {label} seam"
        )));
    }
    Ok(body.replacen(from, to, 1))
}

/// Restore a Full package's pre-resolved dependency closure without npm.
pub fn run_bundled(artifact: &crate::offline::Artifact) -> Result<()> {
    let _activity = ManagedInstallActivity::begin_install()?;
    recover_managed_install_inner()?;

    let live = crate::paths::harness_dir();
    let staging = crate::paths::harness_staging_dir();
    let backup = crate::paths::harness_backup_dir();
    let journal = crate::paths::harness_install_journal();
    remove_dir_if_exists(&staging)?;
    remove_dir_if_exists(&backup)?;
    write_journal(&journal)?;

    let prepared = (|| {
        let file = crate::offline::verified_file(artifact)?;
        std::fs::create_dir_all(&staging).map_err(|cause| {
            Error::Install(format!(
                "could not create the offline install directory: {cause}"
            ))
        })?;
        let decoded = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
        tar::Archive::new(decoded)
            .unpack(&staging)
            .map_err(|cause| {
                Error::Install(format!(
                    "the offline Harness archive could not be unpacked: {cause}"
                ))
            })?;
        require_expected_runtime(&staging)
    })();
    if let Err(failure) = prepared {
        let _ = remove_dir_if_exists(&staging);
        let _ = std::fs::remove_file(&journal);
        return Err(failure);
    }

    promote(&live, &staging, &backup, &journal)
}

fn promote(live: &Path, staging: &Path, backup: &Path, journal: &Path) -> Result<()> {
    if live.exists() {
        std::fs::rename(live, backup).map_err(|cause| {
            Error::Install(format!(
                "could not preserve the current Harness runtime before upgrading: {cause}"
            ))
        })?;
    }

    if let Err(cause) = std::fs::rename(staging, live) {
        if backup.exists() && !live.exists() {
            let _ = std::fs::rename(backup, live);
        }
        return Err(Error::Install(format!(
            "could not activate the verified Harness runtime: {cause}"
        )));
    }

    if let Err(failure) = require_expected_runtime(live) {
        let _ = remove_dir_if_exists(live);
        if backup.exists() {
            let _ = std::fs::rename(backup, live);
        }
        return Err(failure);
    }

    remove_dir_if_exists(backup)?;
    std::fs::remove_file(journal).map_err(|cause| {
        Error::Install(format!(
            "the Harness runtime is ready but its install journal could not be cleared: {cause}"
        ))
    })?;
    Ok(())
}

/// Repair an install interrupted before, during, or after the directory swap.
///
/// Returns `true` when a journal was present. It is safe to call on every
/// environment probe; without the marker it performs no filesystem writes.
pub fn recover_managed_install() -> Result<bool> {
    let Some(_activity) = ManagedInstallActivity::begin_recovery() else {
        return Ok(false);
    };
    recover_managed_install_inner()
}

fn recover_managed_install_inner() -> Result<bool> {
    let journal = crate::paths::harness_install_journal();
    if !journal.exists() {
        return Ok(false);
    }
    read_journal(&journal)?;

    let live = crate::paths::harness_dir();
    let staging = crate::paths::harness_staging_dir();
    let backup = crate::paths::harness_backup_dir();

    if runtime_complete(&live) {
        remove_dir_if_exists(&staging)?;
        remove_dir_if_exists(&backup)?;
    } else if runtime_complete(&backup) {
        remove_dir_if_exists(&live)?;
        std::fs::rename(&backup, &live).map_err(|cause| {
            Error::Install(format!(
                "could not restore the previous Harness runtime: {cause}"
            ))
        })?;
        remove_dir_if_exists(&staging)?;
    } else if runtime_compatible(&staging) {
        remove_dir_if_exists(&live)?;
        std::fs::rename(&staging, &live).map_err(|cause| {
            Error::Install(format!(
                "could not finish activating the Harness runtime: {cause}"
            ))
        })?;
        remove_dir_if_exists(&backup)?;
    } else {
        // Nothing complete existed before or after the interruption. Keeping a
        // marker here would make the Repair button fail on every attempt.
        remove_dir_if_exists(&live)?;
        remove_dir_if_exists(&staging)?;
        remove_dir_if_exists(&backup)?;
    }

    std::fs::remove_file(&journal).map_err(|cause| {
        Error::Install(format!(
            "could not clear the recovered install journal: {cause}"
        ))
    })?;
    Ok(true)
}

/// Version recorded by a complete managed runtime.
pub fn runtime_version(target: &Path) -> Option<String> {
    let manifest = target
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let raw =
        crate::bounded_file::read_string(&manifest, crate::bounded_file::CONTROL_BYTES).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let version = parsed.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// Whether the installed runtime is exactly the family this application tested.
pub fn runtime_compatible(target: &Path) -> bool {
    runtime_contract_failures(target).is_empty()
}

fn runtime_complete(target: &Path) -> bool {
    runtime_version(target).is_some() && entry(target).is_file()
}

fn entry(target: &Path) -> PathBuf {
    target
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

pub fn pnpm_version(target: &Path) -> Option<String> {
    let manifest = target.join("node_modules/pnpm/package.json");
    let raw =
        crate::bounded_file::read_string(&manifest, crate::bounded_file::CONTROL_BYTES).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed.get("version")?.as_str().map(str::to_string)
}

fn pnpm_entry(target: &Path) -> PathBuf {
    target.join("node_modules/pnpm/bin/pnpm.cjs")
}

fn integration_entry(target: &Path) -> PathBuf {
    target.join("node_modules/@moresyl/dsh-studio-integration/lib/client.js")
}

fn runtime_schema(target: &Path) -> Option<u8> {
    let raw = crate::bounded_file::read_string(
        &target.join("dsh-studio-runtime.json"),
        crate::bounded_file::CONTROL_BYTES,
    )
    .ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("schema")?.as_u64()?.try_into().ok()
}

fn qualified_picker(target: &Path) -> bool {
    crate::bounded_file::read_string(
        &target
            .join("node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js"),
        crate::bounded_file::CONTROL_BYTES,
    )
    .is_ok_and(|body| {
        body.contains("__DSH_DESKTOP_PICK_DIRECTORY__")
            && body.contains("__DSH_DESKTOP_VALIDATE_DIRECTORY__")
    })
}

fn require_expected_runtime(target: &Path) -> Result<()> {
    let expected = expected_version(target);
    let actual = runtime_version(target).unwrap_or_else(|| "missing".to_string());
    let actual_pnpm = pnpm_version(target).unwrap_or_else(|| "missing".to_string());
    let failures = runtime_contract_failures(target);
    if !failures.is_empty() {
        return Err(Error::Install(format!(
            "npm finished but the verified runtime is not Studio contract {RUNTIME_SCHEMA} with {PACKAGE}@{expected}, {INTEGRATION_PACKAGE}, and pnpm {PNPM_VERSION} (found {actual} with pnpm {actual_pnpm}; failed: {})",
            failures.join(", ")
        )));
    }
    Ok(())
}

fn runtime_contract_failures(target: &Path) -> Vec<&'static str> {
    let mut failures = Vec::new();
    if runtime_version(target).as_deref() != Some(expected_version(target).as_str()) {
        failures.push("Harness version");
    }
    if !entry(target).is_file() {
        failures.push("Harness entry point");
    }
    if expected_version(target) != VERSION && !target.join("studio-cli.mjs").is_file() {
        failures.push("Studio CLI launcher");
    }
    if pnpm_version(target).as_deref() != Some(PNPM_VERSION) {
        failures.push("pnpm version");
    }
    if !pnpm_entry(target).is_file() {
        failures.push("pnpm entry point");
    }
    if runtime_schema(target) != Some(RUNTIME_SCHEMA) {
        failures.push("runtime marker");
    }
    if !integration_entry(target).is_file() {
        failures.push("Studio integration");
    }
    if !qualified_picker(target) {
        failures.push("qualified directory picker");
    }
    failures
}

fn write_journal(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|cause| {
            Error::Install(format!(
                "could not create the install state directory: {cause}"
            ))
        })?;
    }
    let journal = InstallJournal {
        schema: JOURNAL_VERSION,
        package: PACKAGE.to_string(),
        version: VERSION.to_string(),
    };
    let body = serde_json::to_vec_pretty(&journal)
        .map_err(|cause| Error::Install(format!("could not encode install state: {cause}")))?;
    crate::atomic::write(path, body)
        .map_err(|cause| Error::Install(format!("could not commit install state: {cause}")))
}

fn read_journal(path: &Path) -> Result<InstallJournal> {
    let raw = crate::bounded_file::read(path, crate::bounded_file::CONTROL_BYTES)
        .map_err(|cause| Error::Install(format!("could not read install state: {cause}")))?;
    let journal: InstallJournal = serde_json::from_slice(&raw)
        .map_err(|cause| Error::Install(format!("install state is invalid: {cause}")))?;
    if journal.schema != JOURNAL_VERSION || journal.package != PACKAGE {
        return Err(Error::Install(
            "install state belongs to an unsupported runtime transaction".into(),
        ));
    }
    Ok(journal)
}

fn remove_dir_if_exists(path: &Path) -> Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(cause) => {
            return Err(Error::Install(format!(
                "could not inspect {}: {cause}",
                path.display()
            )))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(Error::Install(format!(
            "refusing to recursively remove non-directory or linked path {}",
            path.display()
        )));
    }
    std::fs::remove_dir_all(path)
        .map_err(|cause| Error::Install(format!("could not remove {}: {cause}", path.display())))
}

async fn forward<P, R>(pipe: P, stream: Stream, report: R, activity: mpsc::Sender<()>)
where
    P: tokio::io::AsyncRead + Unpin,
    R: Fn(Stream, String),
{
    let mut lines = BufReader::new(pipe);
    let mut raw = Vec::new();
    while matches!(
        crate::child_output::next_line(&mut lines, &mut raw).await,
        Ok(true)
    ) {
        // Activity is an edge; one pending wakeup is enough to reset the idle
        // deadline and keeps a noisy child from allocating an unbounded queue.
        let _ = activity.try_send(());
        report(stream, String::from_utf8_lossy(&raw).trim_end().to_string());
    }
}

/// Locate npm's entry script next to a Node executable.
///
/// Running `npm-cli.js` with a known Node is exact: it cannot pick up a
/// different runtime from PATH, and on Windows it avoids invoking `npm.cmd`
/// through the command processor.
pub(crate) fn npm_cli(node: &Path) -> Option<PathBuf> {
    npm_cli_candidates(node)
        .into_iter()
        .find(|candidate| candidate.is_file() && npm_cli_works(node, candidate))
}

/// Layouts used by the official archive, version managers and Homebrew.
///
/// Homebrew exposes `node` through `<prefix>/bin`, but canonicalising that
/// symlink (which runtime discovery intentionally does) produces
/// `<prefix>/Cellar/node/<version>/bin/node`. npm is then either formula-owned
/// under `libexec`, or shared under the Homebrew prefix. Keep both candidates:
/// Apple Silicon and Intel Homebrew use the same Cellar shape with different
/// prefixes.
fn npm_cli_candidates(node: &Path) -> Vec<PathBuf> {
    let Some(directory) = node.parent() else {
        return Vec::new();
    };
    vec![
        // Windows: npm sits beside node.exe.
        directory.join("node_modules/npm/bin/npm-cli.js"),
        // Official Unix archives, nvm, fnm and Volta.
        directory.join("../lib/node_modules/npm/bin/npm-cli.js"),
        // Homebrew formula-owned npm from a canonical Cellar node path.
        directory.join("../libexec/lib/node_modules/npm/bin/npm-cli.js"),
        // Homebrew prefix-owned npm from a canonical Cellar node path.
        directory.join("../../../../lib/node_modules/npm/bin/npm-cli.js"),
    ]
}

/// Prove the entry script belongs to a working npm by executing it with the
/// exact Node runtime Studio selected. A same-named shim elsewhere on PATH is
/// never consulted.
fn npm_cli_works(node: &Path, npm_cli: &Path) -> bool {
    let mut command = std::process::Command::new(node);
    command
        .arg(npm_cli)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    proc_guard::hide_console(&mut command);
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return false;
    };
    let output = std::thread::spawn(move || crate::child_output::capture_sync(stdout, 16 << 10));
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let Ok(Ok(output)) = output.join() else {
        return false;
    };
    status.is_some_and(|status| status.success()) && !output.iter().all(u8::is_ascii_whitespace)
}

/// `PATH` with the chosen Node's directory in front.
fn path_with_node(node: &Path) -> OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let Some(directory) = node.parent() else {
        return existing;
    };

    let mut entries = vec![directory.to_path_buf()];
    entries.extend(std::env::split_paths(&existing));
    std::env::join_paths(entries).unwrap_or(existing)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;
    use std::time::Duration;

    use tokio::process::Command;

    #[tokio::test]
    #[ignore = "downloads and boots an isolated npm runtime selected by DSH_TEST_VERSION"]
    async fn selected_runtime_cold_install_and_boot() {
        let version = std::env::var("DSH_TEST_VERSION").unwrap_or_else(|_| super::VERSION.into());
        super::validate_version(&version).expect("exact version");
        let node = node_runtime::discover_in(Some(&crate::paths::managed_node_dir()))
            .into_iter()
            .find(|node| super::npm_cli(&node.path).is_some())
            .expect("Node with npm");
        let root = std::env::temp_dir().join(format!(
            "dsh-selected-runtime-{}-{}",
            std::process::id(),
            version
        ));
        assert!(!root.exists(), "test directory must be new");
        let plan = super::plan(
            &node.path,
            root.clone(),
            format!("{}@{version}", super::PACKAGE),
        )
        .expect("plan");
        let result = super::install_candidate(&plan, &version, |_, line| eprintln!("{line}")).await;
        if result.is_ok() {
            assert!(super::runtime_compatible(&root));
            assert_eq!(super::expected_version(&root), version);
        }
        super::remove_dir_if_exists(&root).expect("test cleanup");
        if let Ok(expected) = std::env::var("DSH_TEST_EXPECT_ERROR") {
            let failure = result.expect_err("incompatible runtime must not activate");
            assert!(failure.to_string().contains(&expected), "{failure}");
        } else {
            result.expect("candidate install and real startup");
        }
    }

    #[test]
    fn version_input_rejects_tags_ranges_paths_and_command_arguments() {
        for version in [
            "latest",
            "^0.1.1",
            "../runtime",
            "--help",
            "1.0.0+build",
            "v1.0.0",
            "1.0.0\n",
        ] {
            assert!(super::validate_version(version).is_err(), "{version}");
        }
        assert!(super::validate_version("0.1.5-rc.2").is_ok());
    }

    #[test]
    fn cordis_compatibility_floor_accepts_only_supported_exact_caret_or_tilde_versions() {
        assert_eq!(
            super::cordis_compatibility_floor("@deepseek-ai/cordis", "^4.0.1")
                .map(|version| version.to_string()),
            Some("4.0.1".into())
        );
        assert_eq!(
            super::cordis_compatibility_floor("@deepseek-ai/cordis-plugin-hmr", "~1.0.16")
                .map(|version| version.to_string()),
            Some("1.0.16".into())
        );
        assert!(super::cordis_compatibility_floor("@deepseek-ai/dsh-base", "^0.1.1").is_none());
        assert!(
            super::cordis_compatibility_floor("@deepseek-ai/cordis-plugin-hmr", ">=1.0.16")
                .is_none()
        );
    }

    #[test]
    fn verified_version_marker_supports_old_installs_and_rejects_manual_replacement() {
        let root = std::env::temp_dir().join(format!("dsh-version-marker-{}", std::process::id()));
        assert!(!root.exists());
        write_runtime(&root, VERSION, true);
        assert!(
            runtime_compatible(&root),
            "legacy schema without version stays compatible"
        );
        write_runtime(&root, "0.1.5-rc.2", true);
        assert!(
            !runtime_compatible(&root),
            "manual npm replacement is not a verified switch"
        );
        fs::write(
            root.join("dsh-studio-runtime.json"),
            format!(r#"{{"schema":{RUNTIME_SCHEMA},"version":"0.1.5-rc.2"}}"#),
        )
        .unwrap();
        assert!(
            !runtime_compatible(&root),
            "selected runtime needs its verified launcher"
        );
        fs::write(root.join("studio-cli.mjs"), "// test launcher").unwrap();
        assert!(runtime_compatible(&root));
        fs::write(
            root.join("dsh-studio-runtime.json"),
            format!(r#"{{"schema":{RUNTIME_SCHEMA},"version":"latest"}}"#),
        )
        .unwrap();
        assert!(!runtime_compatible(&root));
        remove_dir_if_exists(&root).unwrap();
    }

    #[test]
    fn failed_activation_restores_the_previous_runtime() {
        let root =
            std::env::temp_dir().join(format!("dsh-activation-rollback-{}", std::process::id()));
        assert!(!root.exists());
        let live = root.join("live");
        let staging = root.join("staging");
        let backup = root.join("backup");
        let journal = root.join("journal.json");
        write_runtime(&live, VERSION, true);
        write_runtime(&staging, "0.1.5-rc.2", false);
        fs::write(&journal, "{}").unwrap();
        assert!(super::promote(&live, &staging, &backup, &journal).is_err());
        assert!(runtime_compatible(&live));
        assert_eq!(runtime_version(&live).as_deref(), Some(VERSION));
        assert!(!backup.exists());
        remove_dir_if_exists(&root).unwrap();
    }

    use super::{
        ensure_runtime_resolver, npm_cli_candidates, qualify_runtime, remove_dir_if_exists,
        replace_once, require_expected_runtime, run_command_with_limits, runtime_compatible,
        runtime_version, InstallPlan, INTEGRATION_PACKAGE, INTEGRATION_RESOLVER, OFFICIAL_REGISTRY,
        PACKAGE, PNPM_SPEC, PNPM_VERSION, RUNTIME_LOCK, RUNTIME_PACKAGE, RUNTIME_SCHEMA, SPEC,
        VERSION,
    };

    fn write_runtime(root: &Path, version: &str, entry: bool) {
        let package = root.join("node_modules/@deepseek-ai/dsh");
        fs::create_dir_all(package.join("lib")).expect("runtime directory");
        fs::write(
            package.join("package.json"),
            format!(r#"{{"name":"{PACKAGE}","version":"{version}"}}"#),
        )
        .expect("manifest");
        if entry {
            fs::write(package.join("lib/bin.js"), "").expect("entry");
        }
        let pnpm = root.join("node_modules/pnpm");
        fs::create_dir_all(pnpm.join("bin")).expect("pnpm directory");
        fs::write(
            pnpm.join("package.json"),
            format!(r#"{{"name":"pnpm","version":"{PNPM_VERSION}"}}"#),
        )
        .expect("pnpm manifest");
        fs::write(pnpm.join("bin/pnpm.cjs"), "").expect("pnpm entry");
        let integration = root.join("node_modules/@moresyl/dsh-studio-integration/lib");
        fs::create_dir_all(&integration).expect("integration directory");
        fs::write(integration.join("index.js"), "").expect("integration entry");
        fs::write(integration.join("client.js"), "").expect("integration client");
        let picker = root
            .join("node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js");
        fs::create_dir_all(picker.parent().expect("picker parent")).expect("picker directory");
        fs::write(
            picker,
            "__DSH_DESKTOP_PICK_DIRECTORY__ __DSH_DESKTOP_VALIDATE_DIRECTORY__",
        )
        .expect("qualified picker");
        fs::write(
            root.join("dsh-studio-runtime.json"),
            format!(r#"{{"schema":{RUNTIME_SCHEMA}}}"#),
        )
        .expect("runtime marker");
    }

    #[test]
    fn runtime_contract_is_an_exact_package_spec() {
        assert_eq!(SPEC, format!("{PACKAGE}@{VERSION}"));
        assert!(!SPEC.ends_with("@latest"));
        assert!(!VERSION.starts_with(['^', '~']));
        assert_eq!(PNPM_SPEC, format!("pnpm@{PNPM_VERSION}"));
    }

    #[test]
    fn npm_candidates_cover_official_and_version_manager_layouts() {
        let node = Path::new("/Users/person/.nvm/versions/node/v24.19.0/bin/node");
        let candidates = npm_cli_candidates(node);
        assert!(candidates.contains(&Path::new(
            "/Users/person/.nvm/versions/node/v24.19.0/bin/../lib/node_modules/npm/bin/npm-cli.js"
        ).to_path_buf()));
    }

    #[test]
    fn npm_candidates_cover_both_homebrew_prefixes_after_canonicalization() {
        for prefix in ["/opt/homebrew", "/usr/local"] {
            let node = Path::new(prefix).join("Cellar/node/26.7.0/bin/node");
            let candidates = npm_cli_candidates(&node);
            assert!(candidates.contains(
                &node
                    .parent()
                    .expect("bin")
                    .join("../libexec/lib/node_modules/npm/bin/npm-cli.js")
            ));
            assert!(candidates.contains(
                &node
                    .parent()
                    .expect("bin")
                    .join("../../../../lib/node_modules/npm/bin/npm-cli.js")
            ));
        }
    }

    #[test]
    fn managed_install_uses_the_official_registry_and_exposes_lifecycle_progress() {
        let plan = InstallPlan {
            node: Path::new("node").to_path_buf(),
            npm_cli: Path::new("npm-cli.js").to_path_buf(),
            target: Path::new("runtime").to_path_buf(),
            spec: SPEC.to_string(),
        };
        let locked = plan.to_locked_command();
        let arguments = locked
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(arguments.contains(&"--foreground-scripts".to_string()));
        assert!(arguments.contains(&"--install-links".to_string()));
        assert!(arguments.contains(&format!("--registry={OFFICIAL_REGISTRY}")));
        assert!(arguments.contains(&"--fetch-timeout=60000".to_string()));

        let plugin = plan.to_command();
        let plugin_arguments = plugin
            .as_std()
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(plugin_arguments.contains(&"--foreground-scripts".to_string()));
        assert!(!plugin_arguments
            .iter()
            .any(|value| value.starts_with("--registry=")));
    }

    #[test]
    fn silent_install_fixture() {
        if std::env::var_os("DSH_STUDIO_SILENT_INSTALL_FIXTURE").is_some() {
            std::thread::sleep(Duration::from_secs(10));
        }
    }

    #[tokio::test]
    async fn a_silent_install_is_stopped_instead_of_waiting_forever() {
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command
            .arg("--exact")
            .arg("harness::install::tests::silent_install_fixture")
            .arg("--nocapture")
            .env("DSH_STUDIO_SILENT_INSTALL_FIXTURE", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let failure = run_command_with_limits(
            command,
            |_, _| {},
            "npm ci",
            Duration::from_millis(500),
            Duration::from_secs(5),
            Duration::from_millis(100),
        )
        .await
        .expect_err("silent fixture should time out");
        assert!(failure.to_string().contains("produced no output"));
    }

    #[test]
    fn embedded_runtime_lock_matches_the_qualified_versions() {
        let package: serde_json::Value =
            serde_json::from_slice(RUNTIME_PACKAGE).expect("runtime package contract");
        let dependencies = package["dependencies"]
            .as_object()
            .expect("runtime dependencies");
        assert_eq!(dependencies[PACKAGE], VERSION);
        assert_eq!(dependencies["pnpm"], PNPM_VERSION);
        assert_eq!(
            dependencies[INTEGRATION_PACKAGE],
            "file:dsh-studio-integration"
        );
        assert!(dependencies
            .values()
            .all(|version| version.as_str().is_some_and(|version| {
                !version.starts_with(['^', '~']) && !version.contains('*')
            })));

        let lock: serde_json::Value =
            serde_json::from_slice(RUNTIME_LOCK).expect("runtime package lock");
        assert_eq!(lock["lockfileVersion"], 3);
        assert_eq!(
            lock["packages"][""]["dependencies"],
            package["dependencies"]
        );
        let serialized = String::from_utf8_lossy(RUNTIME_LOCK);
        assert!(!serialized.contains("registry.npmmirror.com"));
        assert!(serialized.contains("https://registry.npmjs.org/"));
    }

    #[test]
    fn compatibility_requires_the_exact_version_and_entry() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-runtime-contract-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        write_runtime(&root, VERSION, true);
        assert_eq!(runtime_version(&root).as_deref(), Some(VERSION));
        assert!(runtime_compatible(&root));

        fs::remove_file(root.join("dsh-studio-runtime.json")).expect("remove marker");
        assert!(!runtime_compatible(&root));
        write_runtime(&root, VERSION, true);

        write_runtime(&root, "0.0.1-rc.1", true);
        assert!(!runtime_compatible(&root));
        write_runtime(&root, VERSION, false);
        let _ = fs::remove_file(root.join("node_modules/@deepseek-ai/dsh/lib/bin.js"));
        assert!(!runtime_compatible(&root));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn launch_support_materializes_and_repairs_the_runtime_resolver() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-runtime-resolver-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        write_runtime(&root, VERSION, true);

        let resolver = ensure_runtime_resolver(&root).expect("materialize resolver");
        assert_eq!(
            fs::read(&resolver).expect("resolver body"),
            INTEGRATION_RESOLVER
        );
        fs::write(&resolver, "stale resolver").expect("stale resolver fixture");
        assert_eq!(
            ensure_runtime_resolver(&root).expect("repair resolver"),
            resolver
        );
        assert_eq!(
            fs::read(&resolver).expect("repaired body"),
            INTEGRATION_RESOLVER
        );

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn launch_support_refuses_an_unsafe_runtime_resolver() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-runtime-resolver-kind-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        write_runtime(&root, VERSION, true);
        let resolver =
            root.join("node_modules/@moresyl/dsh-studio-integration/lib/runtime-resolver.cjs");
        fs::create_dir(&resolver).expect("unsafe resolver directory");

        let failure = ensure_runtime_resolver(&root).expect_err("directory must be refused");
        assert!(failure.to_string().contains("unsafe file"));
        assert!(resolver.is_dir());

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn contract_failure_names_the_missing_studio_integration() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-runtime-contract-failure-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        write_runtime(&root, VERSION, true);
        fs::remove_file(root.join("node_modules/@moresyl/dsh-studio-integration/lib/client.js"))
            .expect("remove integration entry");

        let failure = require_expected_runtime(&root).expect_err("contract should fail");
        assert!(failure.to_string().contains("failed: Studio integration"));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn recursive_cleanup_refuses_an_unexpected_file() {
        let path =
            std::env::temp_dir().join(format!("dsh-studio-runtime-cleanup-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        fs::write(&path, "not a directory").expect("file");
        assert!(remove_dir_if_exists(&path).is_err());
        assert!(path.is_file(), "the refused target must remain untouched");
        fs::remove_file(path).expect("cleanup");
    }

    #[test]
    fn qualification_replacement_is_idempotent_even_when_it_keeps_the_seam() {
        let once = replace_once(
            "before seam after".into(),
            "seam",
            "addition seam",
            "fixture",
        )
        .expect("first qualification");
        let twice = replace_once(once.clone(), "seam", "addition seam", "fixture")
            .expect("second qualification");
        assert_eq!(twice, once);
    }

    #[test]
    fn the_locally_installed_locked_picker_accepts_the_qualification() {
        let source = crate::paths::harness_dir()
            .join("node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js");
        if !source.is_file() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-picker-qualification-{}",
            std::process::id()
        ));
        let target = root
            .join("node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(target.parent().expect("picker parent")).expect("picker directory");
        fs::copy(source, &target).expect("copy locked picker");

        qualify_runtime(&root).expect("qualify locked picker");
        let patched = fs::read_to_string(target).expect("patched picker");
        assert!(patched.contains("__DSH_DESKTOP_PICK_DIRECTORY__"));
        assert!(patched.contains("openDirectory(targetPath)"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn qualification_refuses_an_oversized_picker_bundle() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-picker-oversized-{}",
            std::process::id()
        ));
        let target = root
            .join("node_modules/@deepseek-ai/dsh-client-ui-directory-picker-browse/lib/client.js");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(target.parent().expect("picker parent")).expect("picker directory");
        fs::write(&target, vec![b' '; crate::bounded_file::CONTROL_BYTES + 1])
            .expect("oversized picker");

        let failure = qualify_runtime(&root).expect_err("oversized picker must be refused");

        assert!(failure.to_string().contains("safety limit"));
        assert_eq!(
            fs::metadata(&target).expect("picker remains").len(),
            (crate::bounded_file::CONTROL_BYTES + 1) as u64
        );
        let _ = fs::remove_dir_all(root);
    }
}

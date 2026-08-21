//! Install the harness for the user instead of telling them to.
//!
//! The harness is an npm package, and asking someone to open a terminal and run
//! an install command is the point where a desktop app stops being one. So the
//! shell keeps its own copy under its data directory and installs it with the
//! same Node it already found — no global install, nothing on the user's PATH,
//! and no assumption that `npm` is reachable as a command.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use proc_guard::ProcessGuard;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::supervisor::Stream;
use crate::error::{Error, Result};

/// The package the harness ships as.
pub const PACKAGE: &str = "@deepseek-ai/dsh";

/// One coherent upstream release, never an npm moving tag.
///
/// Every official package in this release depends on the matching rc.8 family,
/// including the public `dsh-code-runtime-worker-thread` package. Pinning the
/// root keeps a newly installed machine from silently selecting an unrelated
/// release graph.
pub const VERSION: &str = "0.1.0-rc.8";
pub const SPEC: &str = "@deepseek-ai/dsh@0.1.0-rc.8";

const JOURNAL_VERSION: u8 = 1;

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
        command
    }
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
pub async fn run<R>(plan: &InstallPlan, guard: &ProcessGuard, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    std::fs::create_dir_all(&plan.target).map_err(|cause| {
        Error::Install(format!(
            "could not create {}: {cause}",
            plan.target.display()
        ))
    })?;

    let mut command = plan.to_command();
    // Guarded, so quitting mid-install does not leave npm and its download
    // workers running against a directory nobody owns any more.
    let mut child = guard.spawn(&mut command).map_err(Error::Spawn)?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let out = tokio::spawn(forward(stdout, Stream::Stdout, report.clone()));
    let err = tokio::spawn(forward(stderr, Stream::Stderr, report));

    let status = child
        .wait()
        .await
        .map_err(|cause| Error::Install(format!("npm could not be waited on: {cause}")))?;
    let _ = tokio::join!(out, err);

    if !status.success() {
        return Err(Error::Install(format!("npm exited with {status}")));
    }
    Ok(())
}

/// Install into an isolated sibling, verify it, then promote it in one rename.
///
/// The journal deliberately has no changing phase field. Recovery derives the
/// truth from the three directories, so a crash can never leave a phase that
/// claims a rename happened when the filesystem says otherwise.
pub async fn run_transactional<R>(plan: &InstallPlan, guard: &ProcessGuard, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    recover_managed_install()?;

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
    if let Err(failure) = run(&staged_plan, guard, report).await {
        let _ = remove_dir_if_exists(&staging);
        let _ = std::fs::remove_file(&journal);
        return Err(failure);
    }

    require_expected_runtime(&staging)?;

    promote(live, &staging, &backup, &journal)
}

/// Restore a Full package's pre-resolved dependency closure without npm.
pub fn run_bundled(artifact: &crate::offline::Artifact) -> Result<()> {
    recover_managed_install()?;

    let live = crate::paths::harness_dir();
    let staging = crate::paths::harness_staging_dir();
    let backup = crate::paths::harness_backup_dir();
    let journal = crate::paths::harness_install_journal();
    remove_dir_if_exists(&staging)?;
    remove_dir_if_exists(&backup)?;
    write_journal(&journal)?;

    let prepared = (|| {
        crate::offline::verify(artifact)?;
        std::fs::create_dir_all(&staging).map_err(|cause| {
            Error::Install(format!(
                "could not create the offline install directory: {cause}"
            ))
        })?;
        let file = std::fs::File::open(&artifact.file).map_err(|cause| {
            Error::Install(format!(
                "could not open the offline Harness archive: {cause}"
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
    } else if runtime_version(&staging).as_deref() == Some(VERSION) {
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
    let raw = std::fs::read_to_string(manifest).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let version = parsed.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// Whether the installed runtime is exactly the family this application tested.
pub fn runtime_compatible(target: &Path) -> bool {
    runtime_version(target).as_deref() == Some(VERSION) && entry(target).is_file()
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

fn require_expected_runtime(target: &Path) -> Result<()> {
    let actual = runtime_version(target).unwrap_or_else(|| "missing".to_string());
    if actual != VERSION || !entry(target).is_file() {
        return Err(Error::Install(format!(
            "npm finished but the verified runtime is not {PACKAGE}@{VERSION} (found {actual})"
        )));
    }
    Ok(())
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
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, body)
        .map_err(|cause| Error::Install(format!("could not write install state: {cause}")))?;
    std::fs::rename(&temporary, path)
        .map_err(|cause| Error::Install(format!("could not commit install state: {cause}")))
}

fn read_journal(path: &Path) -> Result<InstallJournal> {
    let raw = std::fs::read(path)
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

async fn forward<P, R>(pipe: P, stream: Stream, report: R)
where
    P: tokio::io::AsyncRead + Unpin,
    R: Fn(Stream, String),
{
    let mut lines = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        report(stream, line);
    }
}

/// Locate npm's entry script next to a Node executable.
///
/// Running `npm-cli.js` with a known Node is exact: it cannot pick up a
/// different runtime from PATH, and on Windows it avoids invoking `npm.cmd`
/// through the command processor.
pub(crate) fn npm_cli(node: &Path) -> Option<PathBuf> {
    let directory = node.parent()?;
    [
        // Windows: npm sits beside node.exe.
        directory.join("node_modules/npm/bin/npm-cli.js"),
        // Unix: node is in `bin/`, npm one level up in `lib/`.
        directory.join("../lib/node_modules/npm/bin/npm-cli.js"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
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

    use super::{
        remove_dir_if_exists, runtime_compatible, runtime_version, PACKAGE, SPEC, VERSION,
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
    }

    #[test]
    fn runtime_contract_is_an_exact_package_spec() {
        assert_eq!(SPEC, format!("{PACKAGE}@{VERSION}"));
        assert!(!SPEC.ends_with("@latest"));
        assert!(!VERSION.starts_with(['^', '~']));
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

        write_runtime(&root, "0.0.1-rc.1", true);
        assert!(!runtime_compatible(&root));
        write_runtime(&root, VERSION, false);
        let _ = fs::remove_file(root.join("node_modules/@deepseek-ai/dsh/lib/bin.js"));
        assert!(!runtime_compatible(&root));
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
}

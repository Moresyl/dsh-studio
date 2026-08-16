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
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::supervisor::Stream;
use crate::error::{Error, Result};

/// The package the harness ships as.
pub const PACKAGE: &str = "@deepseek-ai/dsh";

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

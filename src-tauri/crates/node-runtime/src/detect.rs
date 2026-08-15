//! Find every Node runtime already present on this machine.
//!
//! Users install Node through wildly different channels, and the copy on `PATH`
//! is often not the newest one — a shell that has never sourced `nvm.sh` sees no
//! Node at all while several sit on disk. So candidates are gathered from the
//! version managers directly, then each one is asked its own version rather than
//! inferred from the directory name.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::version::Version;

const EXECUTABLE: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// Where a runtime was found, so the UI can say something better than a path.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    /// Reachable as plain `node` — what the user's own shell would run.
    Path,
    Nvm,
    Fnm,
    Volta,
    /// A system-wide install directory.
    System,
}

impl Source {
    /// Tie-break order when two sources offer the same version.
    fn rank(self) -> u8 {
        match self {
            Source::Path => 0,
            Source::Fnm => 1,
            Source::Nvm => 2,
            Source::Volta => 3,
            Source::System => 4,
        }
    }
}

/// A Node runtime that exists and answered `--version`.
#[derive(Clone, Debug, Serialize)]
pub struct NodeInstallation {
    pub path: PathBuf,
    pub version: Version,
    pub source: Source,
}

/// Ask a Node binary for its version.
///
/// Returns `None` when the path is not a working Node — a stale version-manager
/// shim, a wrapper that prints a banner, or a broken install.
pub fn probe(path: &Path) -> Option<Version> {
    let mut command = std::process::Command::new(path);
    command.arg("--version");
    proc_guard::hide_console(&mut command);

    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Version::parse(&String::from_utf8_lossy(&output.stdout))
}

/// Every working Node on this machine, newest first.
pub fn discover() -> Vec<NodeInstallation> {
    let mut found: Vec<NodeInstallation> = Vec::new();

    for (candidate, source) in candidates() {
        // Resolve first so the same install reached through two paths — a
        // version-manager shim and its target — is only reported once.
        let resolved = candidate.canonicalize().unwrap_or(candidate);
        if found.iter().any(|existing| existing.path == resolved) {
            continue;
        }
        let Some(version) = probe(&resolved) else {
            continue;
        };
        found.push(NodeInstallation {
            path: resolved,
            version,
            source,
        });
    }

    found.sort_by(|a, b| {
        b.version
            .cmp(&a.version)
            .then_with(|| a.source.rank().cmp(&b.source.rank()))
    });
    found
}

/// Paths worth probing, in the order they should win ties.
fn candidates() -> Vec<(PathBuf, Source)> {
    let mut candidates: Vec<(PathBuf, Source)> = Vec::new();

    for directory in path_directories() {
        let executable = directory.join(EXECUTABLE);
        if executable.is_file() {
            candidates.push((executable, Source::Path));
        }
    }

    let home = dirs::home_dir();

    if cfg!(windows) {
        let appdata = dirs::config_dir(); // %APPDATA% on Windows
        let local = dirs::data_local_dir(); // %LOCALAPPDATA% on Windows

        // nvm-windows keeps `<root>/v22.14.0/node.exe`.
        collect_versioned(
            appdata.as_deref().map(|base| base.join("nvm")),
            &[],
            Source::Nvm,
            &mut candidates,
        );
        // fnm keeps `<root>/node-versions/v22.14.0/installation/node.exe`.
        collect_versioned(
            appdata.as_deref().map(|base| base.join("fnm/node-versions")),
            &["installation"],
            Source::Fnm,
            &mut candidates,
        );
        // Volta keeps `<root>/tools/image/node/22.14.0/node.exe`.
        collect_versioned(
            local
                .as_deref()
                .map(|base| base.join("Volta/tools/image/node")),
            &[],
            Source::Volta,
            &mut candidates,
        );

        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            push_if_file(
                PathBuf::from(program_files).join("nodejs").join(EXECUTABLE),
                Source::System,
                &mut candidates,
            );
        }
    } else {
        // nvm: `~/.nvm/versions/node/v22.14.0/bin/node`
        collect_versioned(
            home.as_deref().map(|base| base.join(".nvm/versions/node")),
            &["bin"],
            Source::Nvm,
            &mut candidates,
        );
        // fnm: `~/.fnm/node-versions/v22.14.0/installation/bin/node`
        collect_versioned(
            home.as_deref().map(|base| base.join(".fnm/node-versions")),
            &["installation", "bin"],
            Source::Fnm,
            &mut candidates,
        );
        // Volta: `~/.volta/tools/image/node/22.14.0/bin/node`
        collect_versioned(
            home.as_deref()
                .map(|base| base.join(".volta/tools/image/node")),
            &["bin"],
            Source::Volta,
            &mut candidates,
        );

        for system in [
            "/opt/homebrew/bin", // Apple silicon Homebrew
            "/usr/local/bin",
            "/usr/bin",
        ] {
            push_if_file(
                Path::new(system).join(EXECUTABLE),
                Source::System,
                &mut candidates,
            );
        }
    }

    candidates
}

fn path_directories() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default()
}

fn push_if_file(path: PathBuf, source: Source, out: &mut Vec<(PathBuf, Source)>) {
    if path.is_file() {
        out.push((path, source));
    }
}

/// Scan a version-manager store: one directory per installed release.
///
/// `suffix` is the path from a release directory down to the directory holding
/// the executable, which differs per manager.
fn collect_versioned(
    root: Option<PathBuf>,
    suffix: &[&str],
    source: Source,
    out: &mut Vec<(PathBuf, Source)>,
) {
    let Some(root) = root else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };

    let mut releases: Vec<(Version, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name();
            let version = Version::parse(&name.to_string_lossy())?;
            let mut executable = entry.path();
            for part in suffix {
                executable.push(part);
            }
            executable.push(EXECUTABLE);
            executable.is_file().then_some((version, executable))
        })
        .collect();

    // Newest release of a given manager first.
    releases.sort_by(|a, b| b.0.cmp(&a.0));
    out.extend(releases.into_iter().map(|(_, path)| (path, source)));
}

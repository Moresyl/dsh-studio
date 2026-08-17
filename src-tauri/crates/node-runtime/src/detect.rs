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

/// Path from an unpacked official release down to the directory holding `node`.
///
/// The Windows zip puts the executable at the top; every other platform's
/// tarball puts it in `bin`. One constant because two things depend on it — the
/// scan below and whatever unpacked the release — and they have to agree.
const RELEASE_SUFFIX: &[&str] = if cfg!(windows) { &[] } else { &["bin"] };

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
    /// Downloaded by this application into its own data directory, for a machine
    /// that had no usable Node of its own.
    Managed,
}

impl Source {
    /// Tie-break order when two sources offer the same version.
    ///
    /// The copy this application downloaded ranks last on purpose: when a
    /// machine has its own Node of the same version, running the one the user's
    /// shell would run is the answer with no surprises in it.
    fn rank(self) -> u8 {
        match self {
            Source::Path => 0,
            Source::Fnm => 1,
            Source::Nvm => 2,
            Source::Volta => 3,
            Source::System => 4,
            Source::Managed => 5,
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

/// Where `node` sits inside a release directory unpacked from an official
/// archive, so a downloader and this scanner cannot disagree about the layout.
pub fn release_executable(release_dir: &Path) -> PathBuf {
    let mut path = release_dir.to_path_buf();
    for part in RELEASE_SUFFIX {
        path.push(part);
    }
    path.push(EXECUTABLE);
    path
}

/// Every working Node this machine already had, newest first.
pub fn discover() -> Vec<NodeInstallation> {
    discover_in(None)
}

/// The same scan, plus a directory of releases this application downloaded.
///
/// The managed store is passed in rather than computed here: this crate knows
/// how to recognise a Node install, and the application knows where it keeps its
/// own data. Handing the path in keeps that split intact.
pub fn discover_in(managed: Option<&Path>) -> Vec<NodeInstallation> {
    let mut found: Vec<NodeInstallation> = Vec::new();

    for (candidate, source) in candidates(managed) {
        // Resolve first so the same install reached through two paths — a
        // version-manager shim and its target — is only reported once.
        let resolved = plain_path(candidate.canonicalize().unwrap_or(candidate));
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

/// Undo the extended-length prefix `canonicalize` leaves on a Windows path.
///
/// `\\?\C:\...` is why the prefix survives so long: every Win32 call accepts it,
/// so a runtime is found, probed and launched through it without complaint. What
/// does not accept it is `cmd.exe` — and the directory an executable sits in is
/// put on the `PATH` of child processes, some of which reach their own tools
/// through a shell. There the prefix stops being a spelling and becomes "the
/// system cannot find the path specified", three processes away from here.
///
/// Public because anything assembling a `PATH` has to be able to insist on it,
/// wherever the path it was handed came from.
#[cfg(windows)]
pub fn plain_path(path: PathBuf) -> PathBuf {
    // A path that is not valid Unicode cannot be reasoned about as text, and a
    // Node install has never been found at one.
    let Some(text) = path.to_str() else {
        return path;
    };

    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{share}"));
    }
    // Only a drive path has a shorter spelling. A volume GUID has none, and
    // returning `Volume{...}\node.exe` would be worse than keeping the prefix.
    match text.strip_prefix(r"\\?\") {
        Some(rest) if is_drive_path(rest) => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(windows)]
fn is_drive_path(text: &str) -> bool {
    let mut characters = text.chars();
    characters
        .next()
        .is_some_and(|letter| letter.is_ascii_alphabetic())
        && characters.next() == Some(':')
        && characters.next() == Some('\\')
}

/// Nothing to undo: no other platform spells a path two ways.
#[cfg(not(windows))]
pub fn plain_path(path: PathBuf) -> PathBuf {
    path
}

/// Paths worth probing, in the order they should win ties.
fn candidates(managed: Option<&Path>) -> Vec<(PathBuf, Source)> {
    let mut candidates: Vec<(PathBuf, Source)> = Vec::new();

    // First because it is the cheapest to rule out — one directory, always ours,
    // and usually absent. Order past this point only decides which spelling of a
    // duplicate is kept; the caller sorts by version regardless.
    collect_versioned(
        managed.map(Path::to_path_buf),
        RELEASE_SUFFIX,
        Source::Managed,
        &mut candidates,
    );

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
            appdata
                .as_deref()
                .map(|base| base.join("fnm/node-versions")),
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

    // Newest release of a given manager first, and the path decides ties: two
    // directories can parse to the same version (`v20.11.0` beside `20.11.0`),
    // and without a tiebreak which one wins would come down to directory order.
    releases.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    out.extend(releases.into_iter().map(|(_, path)| (path, source)));
}

#[cfg(all(test, windows))]
mod tests {
    use super::plain_path;
    use std::path::PathBuf;

    fn plainly(text: &str) -> String {
        plain_path(PathBuf::from(text))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn a_canonicalized_drive_path_loses_its_prefix() {
        // The whole point: this directory ends up on a child's PATH, and a
        // shell in that child has to be able to look an executable up in it.
        assert_eq!(
            plainly(r"\\?\C:\Users\someone\AppData\Local\nvm\v22.14.0\node.exe"),
            r"C:\Users\someone\AppData\Local\nvm\v22.14.0\node.exe"
        );
    }

    #[test]
    fn a_network_share_goes_back_to_its_own_spelling() {
        assert_eq!(
            plainly(r"\\?\UNC\build\tools\node.exe"),
            r"\\build\tools\node.exe"
        );
    }

    #[test]
    fn a_path_with_no_shorter_spelling_is_left_alone() {
        // A volume with no drive letter is reachable *only* through the prefix.
        let guid = r"\\?\Volume{9f3c0000-0000-0000-0000-100000000000}\node.exe";
        assert_eq!(plainly(guid), guid);
    }

    #[test]
    fn an_ordinary_path_is_untouched() {
        assert_eq!(
            plainly(r"C:\Program Files\nodejs\node.exe"),
            r"C:\Program Files\nodejs\node.exe"
        );
        assert_eq!(
            plainly(r"\\build\tools\node.exe"),
            r"\\build\tools\node.exe"
        );
    }
}

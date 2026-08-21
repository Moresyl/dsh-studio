//! Which shell a new terminal opens.
//!
//! The rule is the same on every platform: run the shell the user already uses,
//! and only fall back to the one that is always installed. Nobody configures this
//! in a settings page — they configured it when they installed PowerShell 7 or
//! set `$SHELL`, and a terminal that ignores that is a terminal they will not use.

use std::ffi::{OsStr, OsString};
use std::path::Path;
#[cfg(any(windows, test))]
use std::path::PathBuf;

/// Argv for a new terminal, resolved against `path` — the `PATH` the child will
/// itself be given, not this process's.
///
/// Those differ more often than they look like they should: the pty layer rebuilds
/// `PATH` from the registry on Windows, so a shell installed after this
/// application started is on the child's `PATH` and not on ours.
pub fn argv(path: Option<&OsStr>) -> Vec<OsString> {
    pick(path)
}

/// First of `names` that exists in `path`, searched in the order given.
///
/// Deliberately not a full `which`: no `PATHEXT` expansion, because every caller
/// here passes a name with its extension already on it, and guessing extensions
/// is how you end up launching `pwsh.bat` from somebody's project directory.
#[cfg(any(windows, test))]
fn first_on_path(path: &OsStr, names: &[&str]) -> Option<PathBuf> {
    for name in names {
        for directory in std::env::split_paths(path) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn pick(path: Option<&OsStr>) -> Vec<OsString> {
    // PowerShell 7 first: installing it is a deliberate act, so having it means
    // wanting it. `powershell.exe` next, which is on every Windows there is.
    // `-NoLogo` because a copyright banner is not what the pane is for.
    if let Some(found) = path.and_then(|path| first_on_path(path, &["pwsh.exe", "powershell.exe"]))
    {
        return vec![found.into_os_string(), "-NoLogo".into()];
    }

    // Only if neither PowerShell is reachable, which means something is wrong
    // with `PATH` rather than with the machine.
    vec![std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into())]
}

#[cfg(not(windows))]
fn pick(path: Option<&OsStr>) -> Vec<OsString> {
    // `$SHELL` is the user's answer to this question, given to the system long
    // before this application existed. `PATH` is not consulted: the value is an
    // absolute path by definition, and honouring a relative one would let any
    // directory on `PATH` decide what a terminal runs.
    let _ = path;

    if let Some(shell) = std::env::var_os("SHELL") {
        if Path::new(&shell).is_absolute() && Path::new(&shell).is_file() {
            return vec![shell];
        }
    }

    for candidate in ["/bin/bash", "/bin/sh"] {
        if Path::new(candidate).is_file() {
            return vec![candidate.into()];
        }
    }

    // Nothing found, so the guess that is right on any Unix worth the name.
    vec!["/bin/sh".into()]
}

/// What to call this terminal in a tab, given its argv.
pub fn label(argv: &[OsString]) -> String {
    argv.first()
        .map(Path::new)
        .and_then(Path::file_stem)
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "shell".to_string())
}

#[cfg(test)]
mod tests {
    use super::{argv, first_on_path, label};
    use std::ffi::OsString;
    use std::fs;

    /// A directory holding the named files, plus one that is empty.
    ///
    /// Two directories, because the order the search walks them in is part of what
    /// is being tested: names are tried in the caller's order across the whole
    /// path, not one directory at a time.
    fn fixture(purpose: &str, files: &[&str]) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("dsh-shell-{purpose}-{}", std::process::id()));
        let empty = root.join("empty");
        let full = root.join("full");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&empty).expect("create empty directory");
        fs::create_dir_all(&full).expect("create full directory");
        for name in files {
            fs::write(full.join(name), b"").expect("create fixture file");
        }
        (empty, full)
    }

    #[test]
    fn a_name_is_found_in_a_later_directory() {
        let (empty, full) = fixture("later", &["wanted"]);
        let path = std::env::join_paths([&empty, &full]).expect("join paths");

        assert_eq!(
            first_on_path(&path, &["wanted"]),
            Some(full.join("wanted")),
            "the search stopped at the first directory instead of walking on"
        );
    }

    #[test]
    fn the_first_name_wins_over_the_nearest_directory() {
        // Both exist, in the same directory. Preference is by name order, which is
        // what lets `pwsh` beat `powershell` wherever the two happen to live.
        let (empty, full) = fixture("preference", &["second", "first"]);
        let path = std::env::join_paths([&empty, &full]).expect("join paths");

        assert_eq!(
            first_on_path(&path, &["first", "second"]),
            Some(full.join("first"))
        );
    }

    #[test]
    fn a_directory_is_never_mistaken_for_a_program() {
        let (empty, full) = fixture("directory", &[]);
        fs::create_dir_all(full.join("wanted")).expect("create decoy directory");
        let path = std::env::join_paths([&empty, &full]).expect("join paths");

        assert_eq!(first_on_path(&path, &["wanted"]), None);
    }

    #[test]
    fn a_missing_name_is_absent_rather_than_guessed() {
        let (empty, full) = fixture("missing", &["other"]);
        let path = std::env::join_paths([&empty, &full]).expect("join paths");

        assert_eq!(first_on_path(&path, &["wanted"]), None);
    }

    #[test]
    fn there_is_always_a_shell_to_open() {
        // An empty `PATH` is the worst input there is, and it must still produce
        // something runnable rather than an empty argv the pty would reject.
        let chosen = argv(Some(&OsString::new()));
        assert!(!chosen.is_empty(), "no shell was chosen at all");
        assert!(!chosen[0].is_empty(), "the chosen shell has no program");
    }

    #[test]
    fn a_tab_is_named_after_the_program() {
        #[cfg(windows)]
        let full = OsString::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
        #[cfg(not(windows))]
        let full = OsString::from("/usr/local/bin/fish");

        #[cfg(windows)]
        let expected = "pwsh";
        #[cfg(not(windows))]
        let expected = "fish";

        assert_eq!(label(&[full, "-NoLogo".into()]), expected);
    }

    #[test]
    fn an_empty_argv_still_names_the_tab() {
        assert_eq!(label(&[]), "shell");
    }
}

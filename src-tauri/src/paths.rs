//! Where the application keeps state it owns.
//!
//! The harness is installed into application data rather than next to the
//! binary: it is ~255 MB of npm packages that the user updates on their own
//! schedule, so it must survive an application update and must not require
//! write access to Program Files.

use std::path::PathBuf;

/// Root of everything this application writes.
pub fn app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("dsh-studio")
}

/// Prefix the managed harness is installed into, as an npm project root.
pub fn harness_dir() -> PathBuf {
    app_data_dir().join("harness")
}

/// Entry point of the managed harness CLI.
pub fn harness_entry() -> PathBuf {
    harness_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

/// Prefix for command-line tools the shell installs for its own use.
///
/// Separate from the harness prefix so that reinstalling one never disturbs the
/// other, and so a tool the shell bootstrapped is obviously the shell's and not
/// something the user is expected to maintain.
pub fn tools_dir() -> PathBuf {
    app_data_dir().join("tools")
}

/// Root the harness keeps its own state under: `$DSH_HOME`, else `~/.dsh`.
///
/// This one is not ours. The harness owns the directory, the shell only reads
/// what is in it and asks the harness to change it — which is why the same
/// override the harness honours is honoured here.
pub fn dsh_home() -> PathBuf {
    std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".dsh")
        })
}

/// Directory holding one profile's plugin dependencies and manifest.
pub fn profile_dir(profile: &str) -> PathBuf {
    dsh_home().join("profiles").join(profile)
}

/// Default working directory for harness sessions.
///
/// Tools the agent runs inherit this, so it has to be somewhere the user
/// actually keeps work — never the application install directory.
pub fn default_workspace_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

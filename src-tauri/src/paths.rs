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

/// Default working directory for harness sessions.
///
/// Tools the agent runs inherit this, so it has to be somewhere the user
/// actually keeps work — never the application install directory.
pub fn default_workspace_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

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

/// Sibling used while a complete Harness runtime is assembled and verified.
///
/// A sibling, rather than a child of [`harness_dir`], lets the final promotion
/// be one same-volume rename. The live runtime is never npm's working directory.
pub fn harness_staging_dir() -> PathBuf {
    app_data_dir().join("harness.installing")
}

/// Last complete runtime, kept only across the promotion crash window.
pub fn harness_backup_dir() -> PathBuf {
    app_data_dir().join("harness.previous")
}

/// Durable marker that makes an interrupted runtime promotion recoverable.
pub fn harness_install_journal() -> PathBuf {
    app_data_dir().join("harness-install.json")
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

/// Stable pnpm content-addressed store used by profiles created on this
/// machine. Existing profiles keep the store recorded in their modules state
/// so an application update never strands their already-linked dependencies.
pub fn plugin_store_dir() -> PathBuf {
    tools_dir().join("pnpm-store")
}

/// Short-lived isolated projects used to resolve a plugin's complete dependency
/// graph before the real profile is allowed to change.
pub fn plugin_preflight_dir() -> PathBuf {
    app_data_dir().join("plugin-preflight")
}

/// Persistent application logs, separate from user-owned Harness state.
pub fn logs_dir() -> PathBuf {
    app_data_dir().join("logs")
}

/// Durable state and backups for an in-flight profile package operation.
pub fn plugin_recovery_dir() -> PathBuf {
    app_data_dir().join("plugin-recovery")
}

/// User-selected and custom plugin catalog sources.
pub fn market_sources_file() -> PathBuf {
    app_data_dir().join("market-sources.json")
}

/// The exact Node executable selected by the user. The file is deliberately
/// separate from the runtime manager stores: removing a Node simply makes the
/// choice fall back to the newest supported runtime until it returns.
pub fn node_selection_file() -> PathBuf {
    app_data_dir().join("node-selection.json")
}

/// Where Node runtimes the shell downloaded are unpacked, one directory per
/// release: `.../tools/node/v24.19.0`.
///
/// The same shape the version managers use, which is the point — the scanner
/// that finds an nvm install finds these with the same code, and a user who wants
/// this copy gone can delete a directory named after a version they recognise.
pub fn managed_node_dir() -> PathBuf {
    tools_dir().join("node")
}

/// Where plugin archives installed from a file are kept.
///
/// Kept rather than read and forgotten, because installing from a tarball
/// records the path to it in the profile manifest: the file has to still be
/// there the next time that profile is installed, and the one the user picked
/// may well have been on a stick that has since been taken out.
pub fn imports_dir() -> PathBuf {
    app_data_dir().join("imports")
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

/// Where every profile lives, one directory each.
pub fn profiles_dir() -> PathBuf {
    dsh_home().join("profiles")
}

/// Directory holding one profile's plugin dependencies and manifest.
pub fn profile_dir(profile: &str) -> PathBuf {
    profiles_dir().join(profile)
}

/// Default working directory for harness sessions.
///
/// Tools the agent runs inherit this, so it has to be somewhere the user
/// actually keeps work — never the application install directory.
pub fn default_workspace_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

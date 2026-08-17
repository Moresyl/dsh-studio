//! Everything about running the DeepSeek Harness as a supervised local service.

pub mod commands;
pub mod health;
pub mod install;
pub mod readiness;
pub mod supervisor;

use std::path::PathBuf;

use node_runtime::{NodeInstallation, Version};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::paths;
use install::InstallPlan;
use supervisor::LaunchPlan;

/// Loopback only. Binding anywhere else would expose an agent that can run
/// shell commands to the local network, so it is not a setting.
const BIND_HOST: &str = "127.0.0.1";

/// Let the OS pick the port. Nothing else can collide with the result, which is
/// why the shell never has to ask the user to free port 3080.
const EPHEMERAL_PORT: u16 = 0;

/// Whether this machine can currently run the harness, and what is missing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    /// Best usable runtime, or `None` when nothing qualifies.
    pub node: Option<NodeInstallation>,
    /// Every runtime found, so the UI can explain why one was rejected.
    pub all_node_runtimes: Vec<NodeInstallation>,
    pub minimum_node: Version,
    pub harness_installed: bool,
    pub harness_entry: PathBuf,
    pub workspace: PathBuf,
}

/// Inspect the machine. Cheap enough to call whenever the UI needs it.
pub fn environment() -> Environment {
    // The shell's own store is searched alongside the version managers, so a
    // runtime it installed is chosen by exactly the same rule as one the user
    // installed — and shows up in the same list, labelled for what it is.
    let all_node_runtimes = node_runtime::discover_in(Some(&paths::managed_node_dir()));
    let node = all_node_runtimes
        .iter()
        .find(|install| install.version >= node_runtime::MINIMUM_SUPPORTED)
        .cloned();
    let harness_entry = paths::harness_entry();

    Environment {
        node,
        all_node_runtimes,
        minimum_node: node_runtime::MINIMUM_SUPPORTED,
        harness_installed: harness_entry.is_file(),
        harness_entry,
        workspace: paths::default_workspace_dir(),
    }
}

/// Turn the current environment into a runnable launch, or say what is missing.
pub fn launch_plan() -> Result<LaunchPlan> {
    let environment = environment();

    let node = environment.node.ok_or(Error::NoNodeRuntime {
        minimum: node_runtime::MINIMUM_SUPPORTED,
    })?;
    if !environment.harness_installed {
        return Err(Error::HarnessNotInstalled);
    }

    Ok(LaunchPlan {
        node: node.path,
        entry: environment.harness_entry,
        profile: crate::profiles::selected(),
        workspace: environment.workspace,
        host: BIND_HOST.to_string(),
        port: EPHEMERAL_PORT,
    })
}

/// Work out how to install — or reinstall at the latest release — the harness.
pub fn install_plan() -> Result<InstallPlan> {
    let node = environment().node.ok_or(Error::NoNodeRuntime {
        minimum: node_runtime::MINIMUM_SUPPORTED,
    })?;

    install::plan(
        &node.path,
        paths::harness_dir(),
        format!("{}@latest", install::PACKAGE),
    )
}

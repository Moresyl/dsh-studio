//! Everything about running the DeepSeek Harness as a supervised local service.

pub mod commands;
pub mod composition;
pub mod health;
pub mod install;
pub mod readiness;
pub mod shell_environment;
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
    pub harness_compatible: bool,
    pub harness_version: Option<String>,
    pub expected_harness_version: String,
    pub harness_problem: Option<String>,
    pub harness_entry: PathBuf,
    pub workspace: PathBuf,
    pub workspace_admission: crate::workspace::Admission,
}

/// Inspect the machine. Cheap enough to call whenever the UI needs it.
pub fn environment() -> Environment {
    let harness_problem = install::recover_managed_install()
        .err()
        .map(|failure| failure.to_string());
    // The shell's own store is searched alongside the version managers, so a
    // runtime it installed is chosen by exactly the same rule as one the user
    // installed — and shows up in the same list, labelled for what it is.
    let all_node_runtimes = node_runtime::discover_in(Some(&paths::managed_node_dir()));
    let node = crate::node::selected(&all_node_runtimes);
    let harness_entry = paths::harness_entry();
    let harness_version = install::runtime_version(&paths::harness_dir());
    let harness_installed = harness_entry.is_file() && harness_version.is_some();
    let harness_compatible = install::runtime_compatible(&paths::harness_dir());

    let workspace = crate::workspace::selected();
    let workspace_admission = crate::workspace::inspect(&workspace);
    Environment {
        node,
        all_node_runtimes,
        minimum_node: node_runtime::MINIMUM_SUPPORTED,
        harness_installed,
        harness_compatible,
        harness_version,
        expected_harness_version: install::VERSION.to_string(),
        harness_problem,
        harness_entry,
        workspace,
        workspace_admission,
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
    if !environment.harness_compatible {
        return Err(Error::Install(format!(
            "the installed Harness runtime is {}, but DSH Studio requires {}; reinstall it from the Environment panel",
            environment
                .harness_version
                .as_deref()
                .unwrap_or("unknown"),
            install::VERSION
        )));
    }
    if environment.workspace_admission.blocked() {
        return Err(Error::Workspace(
            environment
                .workspace_admission
                .reason
                .unwrap_or_else(|| "the workspace is not safe to use".into()),
        ));
    }
    let profile = crate::profiles::selected();
    let serves_studio = crate::profiles::prepare_for_studio(&profile)?;
    if let Some(problem) = crate::plugins::recovery::blocking_problem(&profile) {
        return Err(Error::Plugin(problem));
    }

    Ok(LaunchPlan {
        node: node.path,
        entry: environment.harness_entry,
        profile,
        patches: serves_studio
            .then(|| {
                paths::harness_dir()
                    .join("node_modules")
                    .join("@moresyl")
                    .join("dsh-studio-integration")
                    .join("cordis.patch.yml")
            })
            .into_iter()
            .collect(),
        workspace: environment.workspace,
        host: BIND_HOST.to_string(),
        port: crate::startup::harness_port(),
        environment: Default::default(),
    })
}

/// Work out how to install — or reinstall at the latest release — the harness.
pub fn install_plan() -> Result<InstallPlan> {
    let environment = environment();
    let supported = environment
        .all_node_runtimes
        .iter()
        .filter(|install| install.version >= node_runtime::MINIMUM_SUPPORTED)
        .collect::<Vec<_>>();
    if supported.is_empty() {
        return Err(Error::NoNodeRuntime {
            minimum: node_runtime::MINIMUM_SUPPORTED,
        });
    }
    // Launching only needs Node, but installing needs that exact runtime's npm.
    // A newer Node-only package must not hide an older complete installation.
    let selected = environment.node.as_ref().map(|node| node.path.as_path());
    let node = selected
        .and_then(|path| {
            supported
                .iter()
                .copied()
                .find(|install| install.path == path && install::npm_cli(&install.path).is_some())
        })
        .or_else(|| {
            supported
                .into_iter()
                .find(|install| install::npm_cli(&install.path).is_some())
        })
        .ok_or(Error::NpmMissing)?;

    install::plan(&node.path, paths::harness_dir(), install::SPEC.to_string())
}

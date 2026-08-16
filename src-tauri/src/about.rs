//! What this build is, and where it keeps things.
//!
//! An app that cannot tell you its own version is an app you cannot file a
//! useful bug against, and the paths are here for the same reason: when
//! something has gone wrong with an install, the first question is always which
//! directory it went wrong in.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::harness::commands::AppState;
use crate::paths;
use crate::plugins;
use crate::update::{self, Release};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub app_data: PathBuf,
    pub harness_dir: PathBuf,
    pub profile_dir: PathBuf,
}

#[tauri::command]
pub fn app_about(app: tauri::AppHandle) -> About {
    About {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_data: paths::app_data_dir(),
        harness_dir: paths::harness_dir(),
        profile_dir: paths::profile_dir(plugins::PROFILE),
    }
}

/// Ask the release feed whether there is anything newer.
///
/// Only ever on request. Nothing is downloaded and nothing is installed.
#[tauri::command]
pub async fn app_check_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Release> {
    let current = app.package_info().version.to_string();
    let node = crate::harness::environment()
        .node
        .map(|installation| installation.path)
        .ok_or(Error::NoNodeRuntime {
            minimum: node_runtime::MINIMUM_SUPPORTED,
        })?;

    let outcome = update::latest(&node, &current).await;
    if let Err(failure) = &outcome {
        state.supervisor.note(
            crate::harness::supervisor::Stream::Stderr,
            failure.to_string(),
        );
    }
    outcome
}

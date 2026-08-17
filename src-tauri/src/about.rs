//! What this build is, and where it keeps things.
//!
//! An app that cannot tell you its own version is an app you cannot file a
//! useful bug against, and the paths are here for the same reason: when
//! something has gone wrong with an install, the first question is always which
//! directory it went wrong in.

use std::path::PathBuf;

use serde::Serialize;

use crate::paths;
use crate::plugins;

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

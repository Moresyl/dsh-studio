//! Admit a workspace only when its filesystem can preserve the semantics the
//! harness and its tools rely on. Network and removable filesystems are not a
//! safe place for atomic package writes, links or process-owned lock files.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::paths;

const SELECTION_FILE: &str = "workspace.json";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub state: &'static str,
    pub filesystem: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct Selection {
    path: PathBuf,
}

#[derive(Clone)]
struct Store {
    file: PathBuf,
    fallback: PathBuf,
}

impl Store {
    fn managed() -> Self {
        Self {
            file: paths::app_data_dir().join(SELECTION_FILE),
            fallback: paths::default_workspace_dir(),
        }
    }

    fn selected(&self) -> PathBuf {
        std::fs::read(&self.file)
            .ok()
            .and_then(|body| serde_json::from_slice::<Selection>(&body).ok())
            .map(|selection| selection.path)
            .unwrap_or_else(|| self.fallback.clone())
    }

    fn choose(&self, path: &Path) -> Result<PathBuf> {
        let canonical = path.canonicalize().map_err(|cause| {
            Error::Workspace(format!("{} could not be opened: {cause}", path.display()))
        })?;
        let canonical = node_runtime::plain_path(canonical);
        let admission = inspect(&canonical);
        if admission.blocked() {
            return Err(Error::Workspace(admission.reason.unwrap_or_else(|| {
                "the selected directory is not a safe workspace".into()
            })));
        }

        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|cause| {
                Error::Workspace(format!(
                    "{} could not be created: {cause}",
                    parent.display()
                ))
            })?;
        }
        let mut body = serde_json::to_vec_pretty(&Selection {
            path: canonical.clone(),
        })
        .map_err(|cause| Error::Workspace(format!("workspace state is invalid: {cause}")))?;
        body.push(b'\n');
        crate::atomic::write(&self.file, body).map_err(|cause| {
            Error::Workspace(format!(
                "{} could not be committed: {cause}",
                self.file.display()
            ))
        })?;
        Ok(canonical)
    }
}

/// Workspace selected for the next Harness start.
pub fn selected() -> PathBuf {
    Store::managed().selected()
}

/// Validate and remember a workspace selected by a native picker or folder drop.
#[tauri::command]
pub fn workspace_select(path: PathBuf) -> Result<Admission> {
    let selected = Store::managed().choose(&path)?;
    Ok(inspect(&selected))
}

/// Validate a candidate chosen by an embedded Harness UI without persisting it.
#[tauri::command]
pub fn workspace_inspect(path: PathBuf) -> Admission {
    inspect(&path)
}

impl Admission {
    pub fn blocked(&self) -> bool {
        self.state == "blocked"
    }
}

pub fn inspect(path: &Path) -> Admission {
    if !path.is_dir() {
        return Admission {
            state: "blocked",
            filesystem: None,
            reason: Some("the workspace directory does not exist or is not a directory".into()),
        };
    }
    platform(path)
}

#[cfg(not(windows))]
fn platform(_path: &Path) -> Admission {
    Admission {
        state: "safe",
        filesystem: None,
        reason: None,
    }
}

#[cfg(windows)]
fn platform(path: &Path) -> Admission {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    use windows_sys::Win32::Storage::FileSystem::{
        GetDriveTypeW, GetVolumeInformationW, GetVolumePathNameW,
    };
    use windows_sys::Win32::System::WindowsProgramming::{
        DRIVE_FIXED, DRIVE_REMOTE, DRIVE_REMOVABLE,
    };

    let input: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut root = vec![0_u16; 32_768];
    // SAFETY: both buffers are NUL-terminated/writable and the length matches
    // the allocation. The APIs write no more than the supplied capacities.
    if unsafe { GetVolumePathNameW(input.as_ptr(), root.as_mut_ptr(), root.len() as u32) } == 0 {
        return Admission {
            state: "warning",
            filesystem: None,
            reason: Some("Windows could not identify the workspace volume".into()),
        };
    }

    let drive = unsafe { GetDriveTypeW(root.as_ptr()) };
    if drive == DRIVE_REMOTE || drive == DRIVE_REMOVABLE {
        return Admission {
            state: "blocked",
            filesystem: None,
            reason: Some(if drive == DRIVE_REMOTE {
                "network workspaces are blocked because package and lock-file writes are not reliable"
                    .into()
            } else {
                "removable workspaces are blocked because the volume can disappear during a session"
                    .into()
            }),
        };
    }
    if drive != DRIVE_FIXED {
        return Admission {
            state: "warning",
            filesystem: None,
            reason: Some("the workspace is not on a fixed local drive".into()),
        };
    }

    let mut name = vec![0_u16; 64];
    if unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    } == 0
    {
        return Admission {
            state: "warning",
            filesystem: None,
            reason: Some("Windows could not identify the workspace filesystem".into()),
        };
    }
    let end = name
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(name.len());
    classify(&String::from_utf16_lossy(&name[..end]))
}

#[cfg(windows)]
fn classify(filesystem: &str) -> Admission {
    let normalized = filesystem.to_ascii_uppercase();
    if matches!(normalized.as_str(), "NTFS" | "REFS") {
        Admission {
            state: "safe",
            filesystem: Some(filesystem.to_string()),
            reason: None,
        }
    } else if matches!(normalized.as_str(), "FAT" | "FAT32" | "EXFAT") {
        Admission {
            state: "blocked",
            filesystem: Some(filesystem.to_string()),
            reason: Some(format!(
                "{filesystem} cannot provide the links and atomic writes required by the workspace"
            )),
        }
    } else {
        Admission {
            state: "warning",
            filesystem: Some(filesystem.to_string()),
            reason: Some(format!(
                "{filesystem} has not been qualified for agent workspaces"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{inspect, workspace_inspect, Store};

    #[test]
    fn a_missing_workspace_is_blocked() {
        let path = std::env::temp_dir().join("dsh-studio-workspace-that-must-not-exist");
        assert!(inspect(&path).blocked());
        assert!(workspace_inspect(path).blocked());
    }

    #[test]
    fn a_selected_workspace_survives_a_restart() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-workspace-selection-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let workspace = root.join("project");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let store = Store {
            file: root.join("state/workspace.json"),
            fallback: root.join("fallback"),
        };

        let selected = store.choose(&workspace).expect("selected");
        assert_eq!(store.selected(), selected);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_filesystem_contract_is_explicit() {
        assert_eq!(super::classify("NTFS").state, "safe");
        assert_eq!(super::classify("ReFS").state, "safe");
        assert_eq!(super::classify("exFAT").state, "blocked");
        assert_eq!(super::classify("mysteryfs").state, "warning");
    }
}

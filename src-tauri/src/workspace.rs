//! Admit a workspace only when its filesystem can preserve the semantics the
//! harness and its tools rely on. Network and removable filesystems are not a
//! safe place for atomic package writes, links or process-owned lock files.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::{Error, Result};
use crate::paths;

const SELECTION_FILE: &str = "workspace.json";
const WORKTREE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub state: &'static str,
    pub filesystem: Option<String>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: String,
    pub head: String,
    pub primary: bool,
    pub dirty: bool,
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
        crate::bounded_file::read(&self.file, crate::bounded_file::CONTROL_BYTES)
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

/// List Git's durable worktree registry for the selected workspace repository.
#[tauri::command]
pub async fn workspace_worktrees() -> Result<Vec<Worktree>> {
    let repository = repository_root(&selected()).await?;
    worktrees_in(&repository).await
}

/// Create a sibling worktree on a new branch from the selected repository HEAD.
///
/// No remove/force counterpart is exposed: a branch with uncommitted agent work
/// must be reviewed with ordinary Git tools before anyone decides it is safe to
/// discard.
#[tauri::command]
pub async fn workspace_worktree_create(branch: String) -> Result<Vec<Worktree>> {
    if !valid_branch(&branch) {
        return Err(Error::Workspace(
            "the worktree branch must use safe Git branch characters and segments".into(),
        ));
    }
    let repository = repository_root(&selected()).await?;
    let parent = repository.parent().ok_or_else(|| {
        Error::Workspace("the repository has no parent directory for isolated worktrees".into())
    })?;
    let store = parent.join(".dsh-worktrees");
    ensure_worktree_store(&store)?;
    let repository_name = repository
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository");
    let slug = branch.replace('/', "-");
    let destination = store.join(format!("{repository_name}-{slug}"));
    if std::fs::symlink_metadata(&destination).is_ok() {
        return Err(Error::Workspace(format!(
            "the isolated worktree destination already exists: {}",
            destination.display()
        )));
    }

    git(
        &repository,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            destination.to_string_lossy().as_ref(),
            "HEAD",
        ],
        true,
    )
    .await?;
    worktrees_in(&repository).await
}

async fn repository_root(path: &Path) -> Result<PathBuf> {
    let output = git(path, &["rev-parse", "--show-toplevel"], false).await?;
    let root = PathBuf::from(output.trim());
    let canonical = root.canonicalize().map_err(|cause| {
        Error::Workspace(format!(
            "Git returned an unreadable repository root: {cause}"
        ))
    })?;
    if !canonical.is_dir() {
        return Err(Error::Workspace(
            "the selected workspace is not inside a Git repository".into(),
        ));
    }
    Ok(node_runtime::plain_path(canonical))
}

async fn worktrees_in(repository: &Path) -> Result<Vec<Worktree>> {
    let output = git(
        repository,
        &["worktree", "list", "--porcelain", "-z"],
        false,
    )
    .await?;
    let records = parse_worktrees(&output)?;
    let mut worktrees = Vec::with_capacity(records.len());
    for record in records {
        let dirty = !git(&record.path, &["status", "--porcelain=v1", "-uno"], false)
            .await?
            .trim()
            .is_empty();
        worktrees.push(Worktree {
            primary: same_path(&record.path, repository),
            dirty,
            path: record.path,
            branch: record.branch,
            head: record.head,
        });
    }
    Ok(worktrees)
}

struct WorktreeRecord {
    path: PathBuf,
    branch: String,
    head: String,
}

fn parse_worktrees(output: &str) -> Result<Vec<WorktreeRecord>> {
    let mut records = Vec::new();
    let mut path = None;
    let mut branch = None;
    let mut head = None;
    for field in output.split('\0') {
        if field.is_empty() {
            if let Some(path) = path.take() {
                records.push(WorktreeRecord {
                    path,
                    branch: branch.take().unwrap_or_else(|| "(detached)".into()),
                    head: head.take().unwrap_or_default(),
                });
            }
            continue;
        }
        if let Some(value) = field.strip_prefix("worktree ") {
            if path.is_some() {
                return Err(Error::Workspace(
                    "Git returned overlapping worktree records".into(),
                ));
            }
            path = Some(PathBuf::from(value));
        } else if let Some(value) = field.strip_prefix("HEAD ") {
            head = Some(value.chars().take(12).collect());
        } else if let Some(value) = field.strip_prefix("branch ") {
            branch = Some(
                value
                    .strip_prefix("refs/heads/")
                    .unwrap_or(value)
                    .to_string(),
            );
        } else if field == "detached" {
            branch = Some("(detached)".into());
        }
    }
    if path.is_some() {
        return Err(Error::Workspace(
            "Git returned an unterminated worktree record".into(),
        ));
    }
    if records.is_empty() {
        return Err(Error::Workspace("Git returned no worktrees".into()));
    }
    Ok(records)
}

fn valid_branch(branch: &str) -> bool {
    !branch.is_empty()
        && branch.len() <= 128
        && !branch.starts_with(['-', '/', '.'])
        && !branch.ends_with(['/', '.'])
        && !["..", "@{", "//"]
            .into_iter()
            .any(|forbidden| branch.contains(forbidden))
        && branch.split('/').all(|segment| {
            !segment.is_empty()
                && !segment.starts_with('.')
                && !segment.ends_with('.')
                && segment.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
                })
        })
}

fn ensure_worktree_store(store: &Path) -> Result<()> {
    match std::fs::symlink_metadata(store) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(Error::Workspace(format!(
            "{} is not a safe worktree directory",
            store.display()
        ))),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(store)
            .map_err(|cause| {
                Error::Workspace(format!("{} could not be created: {cause}", store.display()))
            }),
        Err(cause) => Err(Error::Workspace(format!(
            "{} could not be inspected: {cause}",
            store.display()
        ))),
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    return left
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy());
    #[cfg(not(windows))]
    return left == right;
}

async fn git(path: &Path, arguments: &[&str], writes: bool) -> Result<String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(path)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", if writes { "1" } else { "0" })
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let output = tokio::time::timeout(WORKTREE_TIMEOUT, command.output())
        .await
        .map_err(|_| Error::Workspace("Git worktree operation timed out".into()))?
        .map_err(|cause| Error::Workspace(format!("Git could not start: {cause}")))?;
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| Error::Workspace("Git returned non-UTF-8 worktree data".into()))?;
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr
        .lines()
        .next()
        .unwrap_or("Git worktree operation failed");
    Err(Error::Workspace(detail.chars().take(500).collect()))
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
    use super::{inspect, parse_worktrees, valid_branch, workspace_inspect, Store};

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

    #[test]
    fn porcelain_worktree_records_are_bounded_and_normalized() {
        let output = "worktree C:\\work\\main\0HEAD 0123456789abcdef\0branch refs/heads/main\0\0worktree C:\\work\\agent\0HEAD abcdef0123456789\0detached\0";
        let records = parse_worktrees(output).expect("records");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].branch, "main");
        assert_eq!(records[0].head, "0123456789ab");
        assert_eq!(records[1].branch, "(detached)");
    }

    #[test]
    fn malformed_worktree_output_is_rejected() {
        assert!(parse_worktrees("worktree C:\\work\\main\0HEAD deadbeef").is_err());
        assert!(parse_worktrees("worktree C:\\one\0worktree C:\\two\0").is_err());
    }

    #[test]
    fn branch_names_cannot_escape_git_or_create_ambiguous_destinations() {
        assert!(valid_branch("agent/ui-fix"));
        assert!(valid_branch("release_2026"));
        for branch in [
            "../main",
            "-force",
            "agent//two",
            "agent@{1}",
            "agent\\two",
            "",
        ] {
            assert!(!valid_branch(branch), "{branch} must be rejected");
        }
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

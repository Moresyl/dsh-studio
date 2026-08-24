//! Crash-safe profile manifest changes for plugin package operations.
//!
//! `pnpm` changes a small set of profile control files before it finishes
//! linking `node_modules`. A normal non-zero exit can be handled by the caller,
//! but power loss and a killed desktop process have no caller left. This module
//! writes a complete before-image and a journal before the package manager is
//! spawned. Startup can therefore restore the exact profile declaration before
//! the Harness is allowed to boot it again.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::paths;

const SCHEMA: u8 = 1;
const MAX_CONTROL_FILE: u64 = 8 << 20;
const CONTROL_FILES: [&str; 5] = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "cordis.patch.yml",
    super::receipts::FILE,
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileImage {
    name: String,
    present: bool,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    schema: u8,
    #[serde(default)]
    generation: String,
    profile: String,
    operation: String,
    subject: String,
    #[serde(default)]
    retry: Option<RetryPlan>,
    files: Vec<FileImage>,
}

/// The exact package operation that may be offered again after rollback.
///
/// Imports are deliberately excluded: their source can be removable media and
/// retaining an arbitrary local path in startup state would turn a recovery
/// button into ambient filesystem authority.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RetryPlan {
    Add {
        spec: String,
        source_id: String,
        item_id: String,
        display_name: String,
    },
    Remove {
        name: String,
    },
}

/// A startup-visible result. It contains no file contents or arbitrary paths.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNotice {
    #[serde(default)]
    pub generation: String,
    pub profile: String,
    pub operation: String,
    pub subject: String,
    pub restored: bool,
    pub detail: String,
    #[serde(default)]
    pub retry: Option<RetryPlan>,
}

/// One operation whose before-image is already durable.
pub struct Transaction {
    store: Store,
    journal: Journal,
}

#[derive(Clone)]
struct Store {
    root: PathBuf,
    profiles: PathBuf,
}

impl Store {
    fn managed() -> Self {
        Self {
            root: paths::plugin_recovery_dir(),
            profiles: paths::profiles_dir(),
        }
    }

    fn journal_path(&self) -> PathBuf {
        self.root.join("transaction.json")
    }

    fn notice_path(&self) -> PathBuf {
        self.root.join("notice.json")
    }

    fn backups(&self) -> PathBuf {
        self.root.join("backups")
    }

    fn profile_dir(&self, profile: &str) -> Result<PathBuf> {
        if !valid_profile(profile) {
            return Err(Error::Plugin("the recovery profile name is invalid".into()));
        }
        Ok(self.profiles.join(profile))
    }

    fn begin(
        &self,
        profile: &str,
        operation: &str,
        subject: &str,
        retry: Option<RetryPlan>,
    ) -> Result<Journal> {
        if self.journal_path().exists() {
            self.recover(false)?;
        }

        let profile_dir = self.profile_dir(profile)?;
        reject_symlink_directory(&profile_dir)?;
        clear_directory(&self.backups())?;
        std::fs::create_dir_all(self.backups()).map_err(|cause| {
            Error::Plugin(format!("could not create plugin recovery backups: {cause}"))
        })?;

        let mut files = Vec::with_capacity(CONTROL_FILES.len());
        for name in CONTROL_FILES {
            files.push(self.capture(&profile_dir, name)?);
        }

        let journal = Journal {
            schema: SCHEMA,
            generation: generation(profile, operation, subject),
            profile: profile.to_string(),
            operation: operation.to_string(),
            subject: subject.to_string(),
            retry,
            files,
        };
        write_json_atomic(&self.journal_path(), &journal)?;
        Ok(journal)
    }

    fn capture(&self, profile_dir: &Path, name: &str) -> Result<FileImage> {
        let source = profile_dir.join(name);
        let Ok(metadata) = std::fs::symlink_metadata(&source) else {
            return Ok(FileImage {
                name: name.to_string(),
                present: false,
                size: 0,
                sha256: String::new(),
            });
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(Error::Plugin(format!(
                "plugin recovery refuses non-regular profile file {name}"
            )));
        }
        if metadata.len() > MAX_CONTROL_FILE {
            return Err(Error::Plugin(format!(
                "profile file {name} is too large to back up safely"
            )));
        }
        let body = std::fs::read(&source)
            .map_err(|cause| Error::Plugin(format!("could not back up {name}: {cause}")))?;
        let digest = hex(&Sha256::digest(&body));
        std::fs::write(self.backups().join(name), &body)
            .map_err(|cause| Error::Plugin(format!("could not preserve {name}: {cause}")))?;
        Ok(FileImage {
            name: name.to_string(),
            present: true,
            size: body.len() as u64,
            sha256: digest,
        })
    }

    fn recover(&self, startup: bool) -> Result<Option<RecoveryNotice>> {
        let path = self.journal_path();
        if !path.exists() {
            return Ok(self.notice());
        }
        let journal: Journal = read_json(&path)?;
        validate_journal(&journal)?;
        let profile_dir = self.profile_dir(&journal.profile)?;
        reject_symlink_directory(&profile_dir)?;

        // Validate every before-image before the first write. A corrupt backup
        // must not cause a knowingly partial rollback.
        let mut bodies = Vec::with_capacity(journal.files.len());
        for image in &journal.files {
            let body = if image.present {
                let body = std::fs::read(self.backups().join(&image.name)).map_err(|cause| {
                    Error::Plugin(format!("plugin recovery backup is unavailable: {cause}"))
                })?;
                if body.len() as u64 != image.size || hex(&Sha256::digest(&body)) != image.sha256 {
                    return Err(Error::Plugin(format!(
                        "plugin recovery backup for {} failed validation",
                        image.name
                    )));
                }
                Some(body)
            } else {
                None
            };
            bodies.push((image.name.clone(), body));
        }

        std::fs::create_dir_all(&profile_dir).map_err(|cause| {
            Error::Plugin(format!("could not restore the plugin profile: {cause}"))
        })?;
        for (name, body) in bodies {
            let target = profile_dir.join(&name);
            match body {
                Some(body) => write_bytes_atomic(&target, &body)?,
                None => remove_file_if_exists(&target)?,
            }
        }

        self.clear_transaction()?;
        let notice = RecoveryNotice {
            generation: journal.generation,
            profile: journal.profile,
            operation: journal.operation,
            subject: journal.subject,
            restored: true,
            detail: if startup {
                "An interrupted plugin operation was rolled back before the profile started."
                    .to_string()
            } else {
                "The failed plugin operation was rolled back.".to_string()
            },
            retry: journal.retry,
        };
        if startup {
            write_json_atomic(&self.notice_path(), &notice)?;
        }
        Ok(Some(notice))
    }

    fn notice(&self) -> Option<RecoveryNotice> {
        read_json(&self.notice_path()).ok()
    }

    fn clear_transaction(&self) -> Result<()> {
        remove_file_if_exists(&self.journal_path())?;
        clear_directory(&self.backups())
    }
}

impl Transaction {
    /// The package operation and all post-install reconciliation succeeded.
    pub fn commit(self) -> Result<()> {
        self.store.clear_transaction()
    }

    /// Restore the exact declaration that existed before the operation.
    pub fn rollback(self) -> Result<RecoveryNotice> {
        let notice = self.store.recover(false)?.unwrap_or(RecoveryNotice {
            generation: self.journal.generation.clone(),
            profile: self.journal.profile.clone(),
            operation: self.journal.operation.clone(),
            subject: self.journal.subject.clone(),
            restored: true,
            detail: "The failed plugin operation was rolled back.".to_string(),
            retry: self.journal.retry.clone(),
        });
        Ok(notice)
    }
}

/// Persist a before-image before a plugin add/remove/import is spawned.
pub fn begin(
    profile: &str,
    operation: &str,
    subject: &str,
    retry: Option<RetryPlan>,
) -> Result<Transaction> {
    let store = Store::managed();
    let journal = store.begin(profile, operation, subject, retry)?;
    Ok(Transaction { store, journal })
}

/// Restore a transaction left by a killed process and persist a UI notice.
pub fn recover_startup() -> Result<Option<RecoveryNotice>> {
    let store = Store::managed();
    match store.recover(true) {
        Ok(notice) => Ok(notice),
        Err(failure) => {
            let journal = read_json::<Journal>(&store.journal_path()).ok();
            let notice = RecoveryNotice {
                generation: journal
                    .as_ref()
                    .map(|state| state.generation.clone())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| generation("unknown", "recover", "failed")),
                profile: journal
                    .as_ref()
                    .map(|state| state.profile.clone())
                    .unwrap_or_default(),
                operation: journal
                    .as_ref()
                    .map(|state| state.operation.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
                subject: journal
                    .as_ref()
                    .map(|state| state.subject.clone())
                    .unwrap_or_default(),
                restored: false,
                detail: failure.to_string(),
                retry: None,
            };
            write_json_atomic(&store.notice_path(), &notice)?;
            Ok(Some(notice))
        }
    }
}

/// Latest unacknowledged startup recovery result.
pub fn notice() -> Option<RecoveryNotice> {
    Store::managed().notice()
}

/// Dismiss the startup recovery result after it has been shown.
pub fn acknowledge() -> Result<()> {
    remove_file_if_exists(&Store::managed().notice_path())
}

/// Re-read one startup result and reject a stale or already-consumed preview.
pub fn checked_notice(generation: &str) -> Result<RecoveryNotice> {
    let notice = notice()
        .ok_or_else(|| Error::Plugin("there is no plugin recovery operation to retry".into()))?;
    if generation.is_empty() || notice.generation != generation {
        return Err(Error::Plugin(
            "the plugin recovery preview is stale; review the current state again".into(),
        ));
    }
    Ok(notice)
}

/// Why `profile` must not be started while an un-restored transaction exists.
pub fn blocking_problem(profile: &str) -> Option<String> {
    let store = Store::managed();
    let journal: Journal = read_json(&store.journal_path()).ok()?;
    (journal.profile == profile).then(|| {
        format!(
            "profile {profile} has an interrupted {} operation for {}; resolve the recovery warning before starting Harness",
            journal.operation, journal.subject
        )
    })
}

fn validate_journal(journal: &Journal) -> Result<()> {
    if journal.schema != SCHEMA
        || !valid_profile(&journal.profile)
        || !valid_generation(&journal.generation)
    {
        return Err(Error::Plugin("plugin recovery state is invalid".into()));
    }
    if journal.files.len() != CONTROL_FILES.len() {
        return Err(Error::Plugin(
            "plugin recovery file set is incomplete".into(),
        ));
    }
    for (image, expected) in journal.files.iter().zip(CONTROL_FILES) {
        if image.name != expected || image.size > MAX_CONTROL_FILE {
            return Err(Error::Plugin("plugin recovery file set is invalid".into()));
        }
    }
    Ok(())
}

fn generation(profile: &str, operation: &str, subject: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seed = format!(
        "{}\0{}\0{}\0{}\0{}",
        std::process::id(),
        now,
        profile,
        operation,
        subject
    );
    hex(&Sha256::digest(seed.as_bytes()))
}

fn valid_generation(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_profile(profile: &str) -> bool {
    !profile.is_empty()
        && profile.len() <= 128
        && !profile.starts_with(['.', '_', '-'])
        && profile.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
}

fn reject_symlink_directory(path: &Path) -> Result<()> {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(Error::Plugin(
            "plugin recovery refuses a linked or non-directory profile".into(),
        ));
    }
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let body = std::fs::read(path)
        .map_err(|cause| Error::Plugin(format!("could not read plugin recovery state: {cause}")))?;
    if body.len() as u64 > MAX_CONTROL_FILE {
        return Err(Error::Plugin("plugin recovery state is too large".into()));
    }
    serde_json::from_slice(&body)
        .map_err(|cause| Error::Plugin(format!("plugin recovery state is invalid: {cause}")))
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let body = serde_json::to_vec_pretty(value).map_err(|cause| {
        Error::Plugin(format!("could not encode plugin recovery state: {cause}"))
    })?;
    write_bytes_atomic(path, &body)
}

fn write_bytes_atomic(path: &Path, body: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|cause| {
            Error::Plugin(format!("could not create plugin recovery state: {cause}"))
        })?;
    }
    crate::atomic::write(path, body)
        .map_err(|cause| Error::Plugin(format!("could not commit plugin recovery state: {cause}")))
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Err(
            Error::Plugin(format!("refusing to remove directory {}", path.display())),
        ),
        Ok(_) => std::fs::remove_file(path).map_err(|cause| {
            Error::Plugin(format!("could not remove {}: {cause}", path.display()))
        }),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(cause) => Err(Error::Plugin(format!(
            "could not inspect {}: {cause}",
            path.display()
        ))),
    }
}

fn clear_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            std::fs::remove_dir_all(path).map_err(|cause| {
                Error::Plugin(format!("could not clear {}: {cause}", path.display()))
            })
        }
        Ok(_) => Err(Error::Plugin(format!(
            "refusing to clear non-directory {}",
            path.display()
        ))),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(cause) => Err(Error::Plugin(format!(
            "could not inspect {}: {cause}",
            path.display()
        ))),
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{RetryPlan, Store};

    fn store() -> (Store, std::path::PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "dsh-studio-plugin-recovery-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        (
            Store {
                root: base.join("state"),
                profiles: base.join("profiles"),
            },
            base,
        )
    }

    #[test]
    fn interrupted_change_restores_present_and_absent_files() {
        let (store, base) = store();
        let profile = store.profiles.join("web");
        fs::create_dir_all(&profile).expect("profile");
        fs::write(profile.join("package.json"), "before").expect("manifest");

        store
            .begin(
                "web",
                "add",
                "plugin-a@1.0.0",
                Some(RetryPlan::Add {
                    spec: "plugin-a@1.0.0".into(),
                    source_id: "npm".into(),
                    item_id: "plugin-a".into(),
                    display_name: "Plugin A".into(),
                }),
            )
            .expect("begin");
        fs::write(profile.join("package.json"), "after").expect("changed");
        fs::write(profile.join("pnpm-lock.yaml"), "new lock").expect("new file");

        let notice = store.recover(true).expect("recover").expect("notice");
        assert!(notice.restored);
        assert_eq!(
            fs::read_to_string(profile.join("package.json")).unwrap(),
            "before"
        );
        assert!(!profile.join("pnpm-lock.yaml").exists());
        assert_eq!(notice.generation.len(), 64);
        assert!(matches!(notice.retry, Some(RetryPlan::Add { .. })));
        assert!(store.notice().is_some());
        fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn corrupt_backup_is_rejected_before_profile_is_changed() {
        let (store, base) = store();
        let profile = store.profiles.join("web");
        fs::create_dir_all(&profile).expect("profile");
        fs::write(profile.join("package.json"), "before").expect("manifest");
        store
            .begin("web", "remove", "plugin-a", None)
            .expect("begin");
        fs::write(store.backups().join("package.json"), "corrupt").expect("corrupt");
        fs::write(profile.join("package.json"), "after").expect("changed");

        assert!(store.recover(true).is_err());
        assert_eq!(
            fs::read_to_string(profile.join("package.json")).unwrap(),
            "after"
        );
        fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn invalid_generation_is_rejected_before_profile_is_changed() {
        let (store, base) = store();
        let profile = store.profiles.join("web");
        fs::create_dir_all(&profile).expect("profile");
        fs::write(profile.join("package.json"), "before").expect("manifest");
        store
            .begin("web", "remove", "plugin-a", None)
            .expect("begin");
        let mut journal: serde_json::Value =
            serde_json::from_slice(&fs::read(store.journal_path()).expect("journal")).unwrap();
        journal["generation"] = "stale".into();
        fs::write(
            store.journal_path(),
            serde_json::to_vec(&journal).expect("json"),
        )
        .expect("tamper");
        fs::write(profile.join("package.json"), "after").expect("changed");

        assert!(store.recover(true).is_err());
        assert_eq!(
            fs::read_to_string(profile.join("package.json")).unwrap(),
            "after"
        );
        fs::remove_dir_all(base).expect("cleanup");
    }
}

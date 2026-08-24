//! Small, same-directory atomic file replacement.
//!
//! A save must not truncate the document already at the selected path when the
//! process, disk, or antivirus interrupts the write. Staging beside the target
//! keeps the final rename on one filesystem; unique create-new names also keep
//! parallel windows from sharing a temporary file.

use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{Error, ErrorKind, Result, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const ATTEMPTS: usize = 32;

/// Write all bytes, flush them, then atomically replace the destination.
pub fn write(path: &Path, body: impl AsRef<[u8]>) -> Result<()> {
    let (temporary, mut file) = stage(path)?;
    let result = (|| {
        file.write_all(body.as_ref())?;
        file.sync_all()?;
        drop(file);
        replace(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn stage(path: &Path) -> Result<(PathBuf, File)> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "an atomic write needs a file name"))?;

    for _ in 0..ATTEMPTS {
        let mut staged = OsString::from(name);
        staged.push(format!(
            ".dsh-studio.{}.{}.tmp",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let temporary = parent.join(staged);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((temporary, file)),
            Err(cause) if cause.kind() == ErrorKind::AlreadyExists => continue,
            Err(cause) => return Err(cause),
        }
    }

    Err(Error::new(
        ErrorKind::AlreadyExists,
        "could not allocate a unique atomic-write staging file",
    ))
}

#[cfg(not(windows))]
fn replace(staged: &Path, target: &Path) -> Result<()> {
    std::fs::rename(staged, target)
}

#[cfg(windows)]
fn replace(staged: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let staged: Vec<u16> = staged.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            staged.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "dsh-studio-atomic-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn replaces_an_existing_file_without_leaving_staging_data() {
        let root = root("replace");
        let path = root.join("report.md");
        std::fs::write(&path, "before").unwrap();

        write(&path, "after").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_failed_commit_keeps_the_target_and_removes_staging_data() {
        let root = root("failed-commit");
        let path = root.join("occupied");
        std::fs::create_dir(&path).unwrap();

        assert!(write(&path, "not a directory").is_err());

        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parallel_writers_never_mix_documents() {
        let root = root("parallel");
        let path = root.join("session.json");
        let left = "L".repeat(256 * 1024);
        let right = "R".repeat(256 * 1024);
        let one = {
            let path = path.clone();
            let left = left.clone();
            std::thread::spawn(move || write(&path, left))
        };
        let two = {
            let path = path.clone();
            let right = right.clone();
            std::thread::spawn(move || write(&path, right))
        };

        one.join().unwrap().unwrap();
        two.join().unwrap().unwrap();

        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved == left || saved == right);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}

//! Bounded, read-only browsing inside the currently selected workspace.
use crate::error::{Error, Result};
use serde::Serialize;
#[cfg(windows)]
use std::fs::File;
use std::fs::Metadata;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const TEXT_LIMIT: usize = 1024 * 1024;
const ENTRY_LIMIT: usize = 1500;
fn denied() -> Error {
    Error::Workspace(
        "only ordinary files and folders inside the current workspace can be browsed".into(),
    )
}
fn linked(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
fn root(selected: &Path, expected: Option<&str>) -> Result<PathBuf> {
    let root = selected.canonicalize().map_err(|_| denied())?;
    let root = node_runtime::plain_path(root);
    if !root.is_dir()
        || expected.is_some_and(|expected| !super::same_path(&root, Path::new(expected)))
    {
        return Err(Error::Workspace(
            "the workspace changed or is unavailable; reopen the file browser".into(),
        ));
    }
    Ok(root)
}
fn resolve(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.len() > 4096 || relative.contains(['\\', ':', '\0']) {
        return Err(denied());
    }
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            return Err(denied());
        };
        path.push(name);
        if linked(&std::fs::symlink_metadata(&path).map_err(|_| denied())?) {
            return Err(denied());
        }
    }
    let canonical = node_runtime::plain_path(path.canonicalize().map_err(|_| denied())?);
    if !canonical.starts_with(root) {
        return Err(denied());
    }
    Ok(canonical)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    directory: bool,
    bytes: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    root: PathBuf,
    relative: String,
    entries: Vec<Entry>,
    limited: bool,
    skipped: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    root: PathBuf,
    relative: String,
    text: String,
    bytes: usize,
    lines: usize,
}

fn list(selected: &Path, expected: Option<&str>, relative: &str) -> Result<Listing> {
    let root = root(selected, expected)?;
    let directory = resolve(&root, relative)?;
    let reader = std::fs::read_dir(directory)
        .map_err(|_| Error::Workspace("this folder could not be read".into()))?;
    let mut entries = Vec::new();
    let mut skipped = 0;
    let mut limited = false;
    for (index, entry) in reader.enumerate() {
        if index >= ENTRY_LIMIT {
            limited = true;
            break;
        }
        let Ok(entry) = entry else {
            skipped += 1;
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            skipped += 1;
            continue;
        };
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            skipped += 1;
            continue;
        };
        if linked(&meta) || (!meta.is_file() && !meta.is_dir()) {
            skipped += 1;
            continue;
        }
        let path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        entries.push(Entry {
            name,
            path,
            directory: meta.is_dir(),
            bytes: if meta.is_file() { meta.len() } else { 0 },
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(Listing {
        root,
        relative: relative.into(),
        entries,
        limited,
        skipped,
    })
}

#[cfg(windows)]
fn handle_inside(file: &File, root: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 32768];
    // Inspect the opened handle, so a directory replacement cannot redirect the read outside the root.
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle() as _,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if count == 0 || count >= buffer.len() {
        return Err(denied());
    }
    let path = node_runtime::plain_path(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..count],
    )));
    if !path.starts_with(root) {
        return Err(denied());
    }
    Ok(())
}

fn read(selected: &Path, expected: &str, relative: &str) -> Result<Text> {
    let root = root(selected, Some(expected))?;
    let path = resolve(&root, relative)?;
    let meta = std::fs::symlink_metadata(&path).map_err(|_| denied())?;
    if !meta.is_file() || linked(&meta) {
        return Err(denied());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(&path)
        .map_err(|_| Error::Workspace("this file could not be opened".into()))?;
    let meta = file.metadata().map_err(|_| denied())?;
    if !meta.is_file() || linked(&meta) {
        return Err(denied());
    }
    #[cfg(windows)]
    handle_inside(&file, &root)?;
    let mut bytes = Vec::new();
    file.take((TEXT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| denied())?;
    if bytes.len() > TEXT_LIMIT {
        return Err(Error::Workspace(
            "preview is limited to UTF-8 text files up to 1 MiB".into(),
        ));
    }
    if bytes.contains(&0) {
        return Err(Error::Workspace(
            "binary files cannot be previewed as text".into(),
        ));
    }
    let length = bytes.len();
    let text = String::from_utf8(bytes)
        .map_err(|_| Error::Workspace("this file is not UTF-8 text".into()))?;
    let lines = if text.is_empty() {
        0
    } else {
        text.lines().count()
    };
    Ok(Text {
        root,
        relative: relative.into(),
        text,
        bytes: length,
        lines,
    })
}

#[tauri::command]
pub async fn workspace_files(relative: String, expected_root: Option<String>) -> Result<Listing> {
    tauri::async_runtime::spawn_blocking(move || {
        list(&super::selected(), expected_root.as_deref(), &relative)
    })
    .await
    .map_err(|_| denied())?
}
#[tauri::command]
pub async fn workspace_file_read(relative: String, expected_root: String) -> Result<Text> {
    tauri::async_runtime::spawn_blocking(move || {
        read(&super::selected(), &expected_root, &relative)
    })
    .await
    .map_err(|_| denied())?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "dsh-file-browser-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        Fixture(root)
    }
    #[test]
    fn directories_sort_first_and_text_is_returned_without_execution() {
        let dir = fixture();
        std::fs::create_dir(dir.0.join("z")).unwrap();
        std::fs::write(
            dir.0.join("a.html"),
            "<script>alert('test')</script>\n第二行",
        )
        .unwrap();
        let listing = list(&dir.0, None, "").unwrap();
        assert_eq!(listing.entries[0].name, "z");
        assert!(!listing.limited);
        let preview = read(&dir.0, listing.root.to_str().unwrap(), "a.html").unwrap();
        assert_eq!(preview.lines, 2);
        assert!(preview.text.starts_with("<script>"));
        assert_eq!(
            list(&dir.0, Some(listing.root.to_str().unwrap()), "z")
                .unwrap()
                .entries
                .len(),
            0
        );
    }
    #[test]
    fn rejects_traversal_absolute_streams_binary_and_stale_roots() {
        let dir = fixture();
        let other = fixture();
        let canonical = root(&dir.0, None).unwrap();
        for path in [
            "../secret",
            "/secret",
            "C:/secret",
            "x:stream",
            "x\\secret",
            ".",
            "a/../b",
        ] {
            assert!(resolve(&canonical, path).is_err(), "{path}");
        }
        assert!(list(&dir.0, Some(other.0.to_str().unwrap()), "").is_err());
        for (name, bytes) in [
            ("binary", vec![0, 1]),
            ("bad", vec![255]),
            ("large", vec![b'a'; TEXT_LIMIT + 1]),
        ] {
            std::fs::write(dir.0.join(name), bytes).unwrap();
            assert!(read(&dir.0, canonical.to_str().unwrap(), name).is_err());
        }
        std::fs::write(dir.0.join("limit"), vec![b'a'; TEXT_LIMIT]).unwrap();
        assert_eq!(
            read(&dir.0, canonical.to_str().unwrap(), "limit")
                .unwrap()
                .bytes,
            TEXT_LIMIT
        );
        assert!(read(&dir.0, canonical.to_str().unwrap(), "").is_err());
    }
    #[test]
    fn excessive_folders_are_bounded_and_missing_files_can_be_retried() {
        let dir = fixture();
        for n in 0..=ENTRY_LIMIT {
            std::fs::write(dir.0.join(n.to_string()), "").unwrap();
        }
        let listing = list(&dir.0, None, "").unwrap();
        assert!(listing.limited);
        assert_eq!(listing.entries.len(), ENTRY_LIMIT);
        assert!(read(&dir.0, listing.root.to_str().unwrap(), "gone").is_err());
        std::fs::write(dir.0.join("gone"), "restored").unwrap();
        assert_eq!(
            read(&dir.0, listing.root.to_str().unwrap(), "gone")
                .unwrap()
                .text,
            "restored"
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_are_hidden_and_cannot_be_followed() {
        let dir = fixture();
        let other = fixture();
        std::fs::write(other.0.join("secret"), "private").unwrap();
        std::os::unix::fs::symlink(&other.0, dir.0.join("link")).unwrap();
        assert_eq!(list(&dir.0, None, "").unwrap().skipped, 1);
        assert!(read(
            &dir.0,
            root(&dir.0, None).unwrap().to_str().unwrap(),
            "link/secret"
        )
        .is_err());
    }
}

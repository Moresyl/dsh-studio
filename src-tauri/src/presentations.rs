//! Bounded local presentation sources. No imported paths or executable content.
pub mod media;
mod package;
mod structure;
mod xml;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

const LIMIT: usize = 2 * 1024 * 1024;
const DOCUMENTS: usize = 100;
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
pub struct SavedPresentation {
    document: Value,
    revision: String,
}

#[derive(Serialize)]
pub struct PresentationSummary {
    id: String,
    title: Option<String>,
}

fn failure(message: &str) -> Error {
    Error::Window(format!("presentation storage: {message}"))
}

fn valid_id(id: &str) -> bool {
    let upper = id.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper
                .strip_prefix(prefix)
                .is_some_and(|tail| tail.len() == 1 && matches!(tail.as_bytes()[0], b'1'..=b'9'))
        });
    !reserved
        && !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn path(root: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(failure("invalid document identity"));
    }
    Ok(root.join(format!("{id}.json")))
}

fn directory(root: &Path) -> Result<()> {
    std::fs::create_dir_all(root).map_err(|_| failure("could not open document directory"))?;
    let info =
        std::fs::symlink_metadata(root).map_err(|_| failure("could not inspect directory"))?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return Err(failure("document directory must be a local directory"));
    }
    Ok(())
}

fn list(root: &Path) -> Result<Vec<String>> {
    directory(root)?;
    let mut ids = Vec::new();
    let entries = std::fs::read_dir(root).map_err(|_| failure("could not list documents"))?;
    // Bound scanning too, including files unrelated to a saved document.
    for (index, entry) in entries.enumerate() {
        if index >= 1000 {
            return Err(failure("too many directory entries"));
        }
        let entry = entry.map_err(|_| failure("could not inspect document entry"))?;
        let file = entry.path();
        if file.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let id = file.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if valid_id(id) {
            ids.push(id.to_string());
            if ids.len() > DOCUMENTS {
                return Err(failure("document library limit exceeded"));
            }
        }
    }
    ids.sort();
    Ok(ids)
}

fn validate(document: &Value, id: &str) -> Result<()> {
    if document.get("format").and_then(Value::as_str) != Some("dsh-studio-presentation")
        || !matches!(document.get("version").and_then(Value::as_u64), Some(1 | 2))
        || document.get("id").and_then(Value::as_str) != Some(id)
        || !document
            .get("title")
            .and_then(Value::as_str)
            .is_some_and(|title| !title.trim().is_empty() && title.encode_utf16().count() <= 160)
        || !document
            .get("slides")
            .and_then(Value::as_array)
            .is_some_and(|v| !v.is_empty() && v.len() <= 100)
    {
        return Err(failure("unsupported document source"));
    }
    // Element semantics are validated by the shared renderer document parser.
    Ok(())
}

fn load(root: &Path, id: &str) -> Result<Option<SavedPresentation>> {
    directory(root)?;
    let file = path(root, id)?;
    match std::fs::symlink_metadata(&file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(info) if info.is_file() && !info.file_type().is_symlink() => {}
        _ => return Err(failure("document is not a readable regular file")),
    }
    let bytes = crate::bounded_file::read(&file, LIMIT)
        .map_err(|_| failure("could not read bounded document"))?;
    let document: Value = serde_json::from_slice(&bytes)
        .map_err(|_| failure("document is damaged; existing file preserved"))?;
    validate(&document, id)?;
    Ok(Some(SavedPresentation {
        document,
        revision: format!("{:x}", Sha256::digest(&bytes)),
    }))
}

fn save(root: &Path, id: &str, source: &str, expected: Option<&str>) -> Result<SavedPresentation> {
    let file = path(root, id)?;
    if source.len() > LIMIT {
        return Err(failure("document size limit exceeded"));
    }
    let document: Value =
        serde_json::from_str(source).map_err(|_| failure("invalid document source"))?;
    validate(&document, id)?;
    let _guard = WRITES
        .lock()
        .map_err(|_| failure("storage is unavailable"))?;
    media::validate_references(root, &document)?;
    let current = load(root, id)?;
    if current.as_ref().map(|v| v.revision.as_str()) != expected {
        return Err(failure(
            "document changed in another window; reload before saving",
        ));
    }
    if current.is_none() && list(root)?.len() >= DOCUMENTS {
        return Err(failure("document library limit exceeded"));
    }
    crate::atomic::write(&file, source)
        .map_err(|_| failure("could not save document; previous version preserved"))?;
    Ok(SavedPresentation {
        document,
        revision: format!("{:x}", Sha256::digest(source.as_bytes())),
    })
}

fn root() -> PathBuf {
    crate::paths::app_data_dir().join("presentations")
}

fn summaries(root: &Path) -> Result<Vec<PresentationSummary>> {
    Ok(list(root)?
        .into_iter()
        .map(|id| {
            let title = load(root, &id)
                .ok()
                .flatten()
                .and_then(|saved| saved.document["title"].as_str().map(str::to_owned));
            PresentationSummary { id, title }
        })
        .collect())
}

#[tauri::command]
pub async fn presentation_list() -> Result<Vec<PresentationSummary>> {
    tokio::task::spawn_blocking(|| summaries(&root()))
        .await
        .map_err(|_| failure("list task failed"))?
}

#[tauri::command]
pub async fn presentation_load(id: String) -> Result<Option<SavedPresentation>> {
    tokio::task::spawn_blocking(move || load(&root(), &id))
        .await
        .map_err(|_| failure("load task failed"))?
}

#[tauri::command]
pub async fn presentation_save(
    id: String,
    source: String,
    revision: Option<String>,
) -> Result<SavedPresentation> {
    tokio::task::spawn_blocking(move || save(&root(), &id, &source, revision.as_deref()))
        .await
        .map_err(|_| failure("save task failed"))?
}

fn export_file(path: &Path, data: &str) -> Result<()> {
    const MAXIMUM: usize = 20 * 1024 * 1024;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pptx"))
        || data.len() > MAXIMUM.div_ceil(3) * 4
    {
        return Err(failure("invalid presentation export destination or size"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| failure("invalid presentation export data"))?;
    if bytes.len() > MAXIMUM {
        return Err(failure("presentation export size limit exceeded"));
    }
    let mut archive = package::Package::open(&bytes)?;
    structure::slides(&mut archive)?;
    archive.verify_contents()?;
    crate::atomic::write(path, bytes)
        .map_err(|_| failure("could not save export at the selected location"))
}

#[tauri::command]
pub async fn presentation_export_save(path: String, data: String) -> Result<()> {
    tokio::task::spawn_blocking(move || export_file(Path::new(&path), &data))
        .await
        .map_err(|_| failure("export save task failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    pub(super) struct Fixture(pub(super) PathBuf);
    impl Fixture {
        pub(super) fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "dsh-presentations-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn source(id: &str, title: &str) -> String {
        serde_json::json!({"format":"dsh-studio-presentation","version":1,"id":id,"title":title,"slides":[{}]}).to_string()
    }
    #[test]
    fn saves_loads_and_rejects_stale_or_missing_revisions() {
        let root = Fixture::new();
        assert!(list(&root.0).unwrap().is_empty());
        assert!(load(&root.0, "report").unwrap().is_none());
        let original = save(&root.0, "report", &source("report", "中文"), None).unwrap();
        assert_eq!(
            load(&root.0, "report").unwrap().unwrap().revision,
            original.revision
        );
        assert!(save(&root.0, "report", &source("report", "lost"), None).is_err());
        let next = save(
            &root.0,
            "report",
            &source("report", "changed"),
            Some(&original.revision),
        )
        .unwrap();
        assert!(save(
            &root.0,
            "report",
            &source("report", "lost"),
            Some(&original.revision)
        )
        .is_err());
        assert_eq!(
            load(&root.0, "report").unwrap().unwrap().revision,
            next.revision
        );
        assert_eq!(list(&root.0).unwrap(), vec!["report"]);
    }
    #[test]
    fn rejects_paths_invalid_sources_and_oversize_without_writing() {
        let root = Fixture::new();
        for id in [
            "",
            "../report",
            "a/b",
            "a\\b",
            "中文",
            "CON",
            "nul",
            "COM1",
            "lpt9",
            &"a".repeat(65),
        ] {
            assert!(save(&root.0, id, &source(id, "title"), None).is_err());
            assert!(load(&root.0, id).is_err());
        }
        for body in [
            "{".into(),
            source("other", "title"),
            "a".repeat(LIMIT + 1),
            "{}".into(),
        ] {
            assert!(save(&root.0, "report", &body, None).is_err());
        }
        assert!(list(&root.0).unwrap().is_empty());
    }
    #[test]
    fn preserves_damaged_files_and_rejects_directories() {
        let root = Fixture::new();
        directory(&root.0).unwrap();
        let file = root.0.join("report.json");
        std::fs::write(&file, b"damaged").unwrap();
        assert!(load(&root.0, "report").is_err());
        assert!(save(&root.0, "report", &source("report", "replacement"), None).is_err());
        assert_eq!(std::fs::read(file).unwrap(), b"damaged");
        std::fs::create_dir(root.0.join("folder.json")).unwrap();
        assert!(load(&root.0, "folder").is_err());
    }
    #[test]
    fn enforces_library_limit_but_allows_existing_updates() {
        let root = Fixture::new();
        for n in 0..DOCUMENTS {
            let id = format!("doc-{n}");
            save(&root.0, &id, &source(&id, "title"), None).unwrap();
        }
        assert!(save(&root.0, "extra", &source("extra", "title"), None).is_err());
        let current = load(&root.0, "doc-0").unwrap().unwrap();
        save(
            &root.0,
            "doc-0",
            &source("doc-0", "updated"),
            Some(&current.revision),
        )
        .unwrap();
    }

    #[test]
    fn concurrent_editors_cannot_overwrite_the_same_revision() {
        let root = Fixture::new();
        let revision = save(&root.0, "report", &source("report", "initial"), None)
            .unwrap()
            .revision;
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let jobs: Vec<_> = (0..2)
            .map(|index| {
                let root = root.0.clone();
                let revision = revision.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    save(
                        &root,
                        "report",
                        &source("report", &format!("editor-{index}")),
                        Some(&revision),
                    )
                    .is_ok()
                })
            })
            .collect();
        let wins = jobs
            .into_iter()
            .map(|job| usize::from(job.join().unwrap()))
            .sum::<usize>();
        assert_eq!(wins, 1);
        let saved = load(&root.0, "report").unwrap().unwrap();
        assert!(saved.document["title"]
            .as_str()
            .unwrap()
            .starts_with("editor-"));
    }

    #[test]
    fn refuses_oversize_and_unsupported_files_already_on_disk() {
        let root = Fixture::new();
        directory(&root.0).unwrap();
        let file = root.0.join("report.json");
        for body in [vec![b' '; LIMIT + 1], b"{}".to_vec()] {
            std::fs::write(&file, &body).unwrap();
            assert!(load(&root.0, "report").is_err());
            assert!(save(&root.0, "report", &source("report", "replacement"), None).is_err());
            assert_eq!(std::fs::read(&file).unwrap(), body);
        }
    }

    #[test]
    fn lists_titles_but_keeps_damaged_entries_identifiable() {
        let root = Fixture::new();
        save(&root.0, "good", &source("good", "中文标题"), None).unwrap();
        std::fs::write(root.0.join("broken.json"), "broken").unwrap();
        assert!(save(&root.0, "huge", &source("huge", &"a".repeat(161)), None).is_err());
        let items = summaries(&root.0).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, "broken");
        assert!(items[0].title.is_none());
        assert_eq!(items[1].title.as_deref(), Some("中文标题"));
    }

    #[test]
    fn exports_package_atomically_and_preserves_existing_output_on_bad_input() {
        let root = Fixture::new();
        directory(&root.0).unwrap();
        let bytes = structure::tests::fixture_bytes();
        let mut damaged = bytes.clone();
        let payload = zip::ZipArchive::new(std::io::Cursor::new(&bytes))
            .unwrap()
            .by_index_raw(0)
            .unwrap()
            .data_start() as usize;
        damaged[payload] ^= 1;
        let path = root.0.join("output.pptx");
        export_file(&path, &STANDARD.encode(&bytes)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        for bad in [
            "!".into(),
            STANDARD.encode(b"not a zip"),
            STANDARD.encode(&damaged),
            STANDARD.encode(structure::tests::missing_slide_bytes()),
            "A".repeat((20 * 1024 * 1024_usize).div_ceil(3) * 4 + 1),
        ] {
            assert!(export_file(&path, &bad).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        assert!(export_file(&root.0.join("output.exe"), &STANDARD.encode(&bytes)).is_err());
        assert!(export_file(
            &root.0.join("missing/output.pptx"),
            &STANDARD.encode(&bytes)
        )
        .is_err());
        let archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        assert!(export_file(
            &path,
            &STANDARD.encode(archive.finish().unwrap().into_inner())
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_documents_and_library_roots() {
        use std::os::unix::fs::symlink;
        let root = Fixture::new();
        directory(&root.0).unwrap();
        let outside = root.0.join("outside.txt");
        std::fs::write(&outside, source("report", "outside")).unwrap();
        symlink(&outside, root.0.join("report.json")).unwrap();
        assert!(load(&root.0, "report").is_err());
        assert!(save(&root.0, "report", &source("report", "overwrite"), None).is_err());
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            source("report", "outside")
        );
        let alias = root.0.join("alias");
        symlink(&root.0, &alias).unwrap();
        assert!(list(&alias).is_err());
    }
}

//! Project-scoped notes in application storage, with atomic, revision-checked writes.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::error::{Error, Result};

const STORE_LIMIT: usize = 4 * 1024 * 1024;
const BODY_LIMIT: usize = 64 * 1024;
const NOTES_PER_PROJECT: usize = 100;
const PROJECT_LIMIT: usize = 200;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub body: String,
    pub revision: u64,
    pub updated: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub id: String,
    pub title: String,
    pub body: String,
    pub revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    root: PathBuf,
    notes: Vec<Note>,
    drafts: Vec<RecoveredDraft>,
}

#[derive(Debug, Serialize)]
pub struct RecoveredDraft {
    editor: String,
    note: Note,
    revision: String,
}

fn draft_revision(note: &Note) -> Result<String> {
    let bytes = serde_json::to_vec(note).map_err(|_| failure("could not encode draft"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u8,
    projects: BTreeMap<String, BTreeMap<String, Note>>,
    #[serde(default)]
    drafts: BTreeMap<String, BTreeMap<String, Note>>,
}

pub struct Store {
    path: PathBuf,
    writes: Mutex<()>,
}

impl Default for Store {
    fn default() -> Self {
        Self::at(crate::paths::app_data_dir().join("project-notes.json"))
    }
}

fn failure(message: &str) -> Error {
    Error::Workspace(format!("project notes: {message}"))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_content(title: &str, body: &str) -> bool {
    !title.trim().is_empty()
        && title.len() <= 960
        && title.chars().count() <= 240
        && !title.chars().any(char::is_control)
        && body.len() <= BODY_LIMIT
        && !body.contains('\0')
}

fn project_key(root: &Path) -> String {
    let path = root.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}

impl Snapshot {
    fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.projects.len() > PROJECT_LIMIT
            || self.projects.iter().any(|(project, notes)| {
                project.is_empty()
                    || project.len() > 8192
                    || project.contains('\0')
                    || notes.len() > NOTES_PER_PROJECT
                    || notes.iter().any(|(id, note)| {
                        id != &note.id
                            || !valid_id(id)
                            || !valid_content(&note.title, &note.body)
                            || note.revision == 0
                            || note.revision >= 9_007_199_254_740_991
                            || note.updated > 9_007_199_254_740_991
                    })
            })
            || self.drafts.len() > PROJECT_LIMIT
            || self.drafts.iter().any(|(project, drafts)| {
                project.is_empty()
                    || project.len() > 8192
                    || project.contains('\0')
                    || drafts.len() > NOTES_PER_PROJECT
                    || drafts.iter().any(|(editor, note)| {
                        !valid_id(editor)
                            || !valid_id(&note.id)
                            || !valid_content(&note.title, &note.body)
                            || note.revision >= 9_007_199_254_740_991
                            || note.updated > 9_007_199_254_740_991
                    })
            })
        {
            return Err(failure(
                "unsupported or damaged data; existing file preserved",
            ));
        }
        Ok(())
    }
}

impl Store {
    fn at(path: PathBuf) -> Self {
        Self {
            path,
            writes: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<Snapshot> {
        let bytes = match crate::bounded_file::read(&self.path, STORE_LIMIT) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Snapshot {
                    version: 1,
                    projects: BTreeMap::new(),
                    drafts: BTreeMap::new(),
                })
            }
            Err(_) => return Err(failure("could not read storage; existing file preserved")),
        };
        let snapshot: Snapshot = serde_json::from_slice(&bytes)
            .map_err(|_| failure("damaged data; existing file preserved"))?;
        snapshot.validate()?;
        Ok(snapshot)
    }

    fn commit(&self, snapshot: &Snapshot) -> Result<()> {
        snapshot.validate()?;
        let bytes = serde_json::to_vec(snapshot).map_err(|_| failure("could not encode note"))?;
        if bytes.len() > STORE_LIMIT {
            return Err(failure("storage limit reached; previous notes preserved"));
        }
        crate::atomic::write(&self.path, bytes)
            .map_err(|_| failure("could not save; previous notes preserved"))
    }

    fn list(&self, root: PathBuf) -> Result<Collection> {
        let snapshot = self.read()?;
        let mut notes: Vec<_> = snapshot
            .projects
            .get(&project_key(&root))
            .into_iter()
            .flat_map(|notes| notes.values().cloned())
            .collect();
        notes.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.id.cmp(&b.id)));
        let drafts = snapshot
            .drafts
            .get(&project_key(&root))
            .into_iter()
            .flat_map(|drafts| {
                drafts.iter().map(|(editor, note)| {
                    Ok(RecoveredDraft {
                        editor: editor.clone(),
                        note: note.clone(),
                        revision: draft_revision(note)?,
                    })
                })
            })
            .collect::<Result<_>>()?;
        Ok(Collection {
            root,
            notes,
            drafts,
        })
    }

    fn checkpoint(&self, root: &Path, editor: &str, input: Input) -> Result<()> {
        if !valid_id(editor) || !valid_id(&input.id) || !valid_content(&input.title, &input.body) {
            return Err(failure("invalid draft"));
        }
        let _guard = self
            .writes
            .lock()
            .map_err(|_| failure("storage is unavailable"))?;
        let mut snapshot = self.read()?;
        snapshot
            .drafts
            .entry(project_key(root))
            .or_default()
            .insert(
                editor.into(),
                Note {
                    id: input.id,
                    title: input.title,
                    body: input.body,
                    revision: input.revision,
                    updated: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|_| failure("system clock is unavailable"))?
                        .as_millis()
                        .try_into()
                        .map_err(|_| failure("system clock is out of range"))?,
                },
            );
        self.commit(&snapshot)
    }

    #[cfg(test)]
    fn save(&self, root: &Path, input: Input) -> Result<Note> {
        self.save_editor(root, input, None)
    }

    fn save_editor(&self, root: &Path, input: Input, editor: Option<&str>) -> Result<Note> {
        if editor.is_some_and(|id| !valid_id(id)) {
            return Err(failure("invalid editor identity"));
        }
        if !valid_id(&input.id) || !valid_content(&input.title, &input.body) {
            return Err(failure(
                "invalid title or note; notes support up to 64 KiB of UTF-8 text",
            ));
        }
        let _guard = self
            .writes
            .lock()
            .map_err(|_| failure("storage is unavailable"))?;
        let mut snapshot = self.read()?;
        let notes = snapshot.projects.entry(project_key(root)).or_default();
        let revision = notes.get(&input.id).map_or(0, |note| note.revision);
        if revision != input.revision {
            return Err(failure(
                "note changed in another window; your draft was kept",
            ));
        }
        let note = Note {
            id: input.id,
            title: input.title,
            body: input.body,
            revision: revision + 1,
            updated: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| failure("system clock is unavailable"))?
                .as_millis()
                .try_into()
                .map_err(|_| failure("system clock is out of range"))?,
        };
        notes.insert(note.id.clone(), note.clone());
        if let Some(drafts) = snapshot.drafts.get_mut(&project_key(root)) {
            if let Some(editor) = editor {
                drafts.remove(editor);
            }
            if drafts.is_empty() {
                snapshot.drafts.remove(&project_key(root));
            }
        }
        self.commit(&snapshot)?;
        Ok(note)
    }

    fn discard_draft(&self, root: &Path, editor: &str, expected: &str) -> Result<()> {
        if !valid_id(editor) {
            return Err(failure("invalid draft identity"));
        }
        let _guard = self
            .writes
            .lock()
            .map_err(|_| failure("storage is unavailable"))?;
        let mut snapshot = self.read()?;
        let key = project_key(root);
        let drafts = snapshot
            .drafts
            .get_mut(&key)
            .ok_or_else(|| failure("draft no longer exists"))?;
        let note = drafts
            .get(editor)
            .ok_or_else(|| failure("draft no longer exists"))?;
        if draft_revision(note)? != expected {
            return Err(failure(
                "draft changed in another window; refresh before discarding",
            ));
        }
        drafts.remove(editor);
        if drafts.is_empty() {
            snapshot.drafts.remove(&key);
        }
        self.commit(&snapshot)
    }

    fn remove(&self, root: &Path, id: &str, revision: u64) -> Result<()> {
        if !valid_id(id) {
            return Err(failure("invalid note identity"));
        }
        let _guard = self
            .writes
            .lock()
            .map_err(|_| failure("storage is unavailable"))?;
        let mut snapshot = self.read()?;
        let key = project_key(root);
        let notes = snapshot
            .projects
            .get_mut(&key)
            .ok_or_else(|| failure("note no longer exists"))?;
        if notes.get(id).is_none_or(|note| note.revision != revision) {
            return Err(failure(
                "note changed in another window; refresh before deleting",
            ));
        }
        notes.remove(id);
        if notes.is_empty() {
            snapshot.projects.remove(&key);
        }
        self.commit(&snapshot)
    }
}

#[tauri::command]
pub async fn workspace_notes(
    store: State<'_, Arc<Store>>,
    expected_root: Option<String>,
) -> Result<Collection> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        store.list(super::files::root(
            &super::selected(),
            expected_root.as_deref(),
        )?)
    })
    .await
    .map_err(|_| failure("request failed"))?
}

#[tauri::command]
pub async fn workspace_note_save(
    store: State<'_, Arc<Store>>,
    expected_root: String,
    note: Input,
    editor: String,
) -> Result<Note> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        store.save_editor(
            &super::files::root(&super::selected(), Some(&expected_root))?,
            note,
            Some(&editor),
        )
    })
    .await
    .map_err(|_| failure("request failed"))?
}

#[tauri::command]
pub async fn workspace_note_checkpoint(
    store: State<'_, Arc<Store>>,
    expected_root: String,
    editor: String,
    note: Input,
) -> Result<()> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        store.checkpoint(
            &super::files::root(&super::selected(), Some(&expected_root))?,
            &editor,
            note,
        )
    })
    .await
    .map_err(|_| failure("request failed"))?
}

#[tauri::command]
pub async fn workspace_note_draft_remove(
    store: State<'_, Arc<Store>>,
    expected_root: String,
    editor: String,
    revision: String,
) -> Result<()> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        store.discard_draft(
            &super::files::root(&super::selected(), Some(&expected_root))?,
            &editor,
            &revision,
        )
    })
    .await
    .map_err(|_| failure("request failed"))?
}

#[tauri::command]
pub async fn workspace_note_remove(
    store: State<'_, Arc<Store>>,
    expected_root: String,
    id: String,
    revision: u64,
) -> Result<()> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        store.remove(
            &super::files::root(&super::selected(), Some(&expected_root))?,
            &id,
            revision,
        )
    })
    .await
    .map_err(|_| failure("request failed"))?
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
            "dsh-notes-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        Fixture(root)
    }
    fn input(id: &str, revision: u64) -> Input {
        Input {
            id: id.into(),
            title: "项目计划".into(),
            body: "<script>literal</script>\n任务".into(),
            revision,
        }
    }
    #[test]
    fn notes_survive_restart_and_stay_project_scoped() {
        let dir = fixture();
        let store = Store::at(dir.0.join("notes.json"));
        let one = dir.0.join("one");
        let two = dir.0.join("two");
        let saved = store.save(&one, input("a", 0)).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(
            Store::at(store.path.clone())
                .list(one.clone())
                .unwrap()
                .notes,
            [saved]
        );
        assert!(store.list(two.clone()).unwrap().notes.is_empty());
        store.save(&two, input("a", 0)).unwrap();
        assert_eq!(store.save(&one, input("a", 1)).unwrap().revision, 2);
        assert_eq!(store.list(two).unwrap().notes[0].revision, 1);
        store.remove(&one, "a", 2).unwrap();
        assert!(store.list(one).unwrap().notes.is_empty());
    }
    #[test]
    fn conflicts_and_bad_values_never_replace_existing_notes() {
        let dir = fixture();
        let store = Store::at(dir.0.join("notes.json"));
        store.save(&dir.0, input("a", 0)).unwrap();
        let original = std::fs::read(&store.path).unwrap();
        assert!(store.save(&dir.0, input("a", 0)).is_err());
        assert!(store.remove(&dir.0, "a", 0).is_err());
        assert!(store.remove(&dir.0, "missing", 0).is_err());
        for id in ["../a", "a/b", "", "a:stream", "a\0b"] {
            assert!(store.save(&dir.0, input(id, 0)).is_err());
            assert!(store.remove(&dir.0, id, 1).is_err());
        }
        for (title, body) in [
            (" ".into(), "text".into()),
            ("a\nb".into(), "text".into()),
            ("x".repeat(241), "text".into()),
            ("ok".into(), "x".repeat(BODY_LIMIT + 1)),
            ("ok".into(), "x\0y".into()),
        ] {
            let mut bad = input("a", 1);
            bad.title = title;
            bad.body = body;
            assert!(store.save(&dir.0, bad).is_err());
        }
        assert_eq!(std::fs::read(&store.path).unwrap(), original);
        let mut boundary = input("limit", 0);
        boundary.body = "a".repeat(BODY_LIMIT);
        assert!(store.save(&dir.0, boundary).is_ok());
    }
    #[test]
    fn damaged_storage_and_limits_are_preserved() {
        let dir = fixture();
        let store = Store::at(dir.0.join("notes.json"));
        std::fs::write(&store.path, "{broken").unwrap();
        assert!(store.list(dir.0.clone()).is_err());
        assert!(store.save(&dir.0, input("a", 0)).is_err());
        assert_eq!(std::fs::read_to_string(&store.path).unwrap(), "{broken");
        std::fs::remove_file(&store.path).unwrap();
        for n in 0..NOTES_PER_PROJECT {
            store.save(&dir.0, input(&format!("n-{n}"), 0)).unwrap();
        }
        assert!(store.save(&dir.0, input("overflow", 0)).is_err());
        assert_eq!(
            store.list(dir.0.clone()).unwrap().notes.len(),
            NOTES_PER_PROJECT
        );
        assert!(store.save(&dir.0, input("n-0", 1)).is_ok());
    }
    #[test]
    fn concurrent_editors_cannot_overwrite_each_other() {
        let dir = fixture();
        let store = Arc::new(Store::at(dir.0.join("notes.json")));
        store.save(&dir.0, input("a", 0)).unwrap();
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let store = Arc::clone(&store);
                let root = dir.0.clone();
                std::thread::spawn(move || store.save(&root, input("a", 1)))
            })
            .collect();
        let wins = handles
            .into_iter()
            .map(|handle| handle.join().unwrap().is_ok())
            .filter(|won| *won)
            .count();
        assert_eq!(wins, 1);
        assert_eq!(store.list(dir.0.clone()).unwrap().notes[0].revision, 2);
    }

    #[test]
    fn interrupted_and_conflicting_drafts_survive_restart() {
        let dir = fixture();
        let store = Store::at(dir.0.join("notes.json"));
        let original = store.save(&dir.0, input("a", 0)).unwrap();
        let mut draft = input("a", 1);
        draft.body = "unfinished changes".into();
        store
            .checkpoint(&dir.0, "editor-one", draft.clone())
            .unwrap();
        store
            .checkpoint(&dir.0, "editor-two", input("b", 0))
            .unwrap();
        let restarted = Store::at(store.path.clone());
        let collection = restarted.list(dir.0.clone()).unwrap();
        assert_eq!(collection.notes, [original]);
        assert_eq!(collection.drafts.len(), 2);
        assert_eq!(collection.drafts[0].note.body, draft.body);
        assert!(restarted
            .list(dir.0.join("other"))
            .unwrap()
            .drafts
            .is_empty());
        restarted.save(&dir.0, input("a", 1)).unwrap();
        assert!(restarted
            .save_editor(&dir.0, draft.clone(), Some("editor-one"))
            .is_err());
        assert_eq!(restarted.list(dir.0.clone()).unwrap().drafts.len(), 2);
        draft.revision = 2;
        restarted
            .save_editor(&dir.0, draft, Some("editor-one"))
            .unwrap();
        let collection = restarted.list(dir.0.clone()).unwrap();
        assert_eq!(collection.notes[0].revision, 3);
        assert_eq!(collection.drafts.len(), 1);
        assert_eq!(collection.drafts[0].editor, "editor-two");
    }

    #[test]
    fn discarding_requires_the_reviewed_draft_hash() {
        let dir = fixture();
        let store = Store::at(dir.0.join("notes.json"));
        store.checkpoint(&dir.0, "editor", input("a", 0)).unwrap();
        let reviewed = store.list(dir.0.clone()).unwrap().drafts[0]
            .revision
            .clone();
        assert_eq!(reviewed.len(), 64);
        let mut changed = input("a", 0);
        changed.body = "newer draft".into();
        store.checkpoint(&dir.0, "editor", changed).unwrap();
        let before = std::fs::read(&store.path).unwrap();
        assert!(store.discard_draft(&dir.0, "editor", &reviewed).is_err());
        assert!(store.discard_draft(&dir.0, "missing", &reviewed).is_err());
        assert!(store.discard_draft(&dir.0, "../editor", &reviewed).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), before);
        let latest = store.list(dir.0.clone()).unwrap().drafts[0]
            .revision
            .clone();
        store.discard_draft(&dir.0, "editor", &latest).unwrap();
        assert!(store.list(dir.0.clone()).unwrap().drafts.is_empty());
        assert!(store.discard_draft(&dir.0, "editor", &latest).is_err());
    }

    #[test]
    fn malformed_versions_and_failed_writes_preserve_content() {
        let dir = fixture();
        let store = Store::at(dir.0.join("notes.json"));
        for broken in [
            r#"{"version":2,"projects":{}}"#,
            r#"{"version":1,"projects":{},"unknown":true}"#,
            r#"{"version":1,"projects":[],"drafts":{}}"#,
        ] {
            std::fs::write(&store.path, broken).unwrap();
            assert!(store.checkpoint(&dir.0, "editor", input("a", 0)).is_err());
            assert_eq!(std::fs::read_to_string(&store.path).unwrap(), broken);
        }
        let unavailable = Store::at(dir.0.join("missing").join("notes.json"));
        assert!(unavailable
            .checkpoint(&dir.0, "editor", input("a", 0))
            .is_err());
        assert!(unavailable.save(&dir.0, input("a", 0)).is_err());
        assert!(!unavailable.path.exists());
    }

    #[test]
    fn checkpoint_validation_and_storage_budget_never_truncate_notes() {
        let dir = fixture();
        let store = Store::at(dir.0.join("notes.json"));
        store.save(&dir.0, input("a", 0)).unwrap();
        let before = std::fs::read(&store.path).unwrap();
        assert!(store
            .checkpoint(&dir.0, "../editor", input("a", 1))
            .is_err());
        let mut invalid = input("a", 1);
        invalid.body = "界".repeat(BODY_LIMIT / 3 + 1);
        assert!(store.checkpoint(&dir.0, "editor", invalid).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), before);
        let mut filled = store.read().unwrap();
        for n in 0..64 {
            let mut note = store.list(dir.0.clone()).unwrap().notes[0].clone();
            note.id = format!("n-{n}");
            note.body = "a".repeat(BODY_LIMIT);
            filled
                .projects
                .get_mut(&project_key(&dir.0))
                .unwrap()
                .insert(note.id.clone(), note);
        }
        assert!(store.commit(&filled).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), before);
    }
}

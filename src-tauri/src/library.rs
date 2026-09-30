//! Personal organization lives outside the runtime's append-only session logs.
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{Error, Result};

const LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation {
    pub title: String,
    pub pinned: bool,
    pub tags: Vec<String>,
    pub note: String,
    pub bookmarks: BTreeSet<u64>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationPatch {
    title: Option<String>,
    pinned: Option<bool>,
    tags: Option<Vec<String>>,
    note: Option<String>,
    bookmarks: Option<BTreeSet<u64>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prompt {
    pub id: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub version: u8,
    pub sessions: BTreeMap<String, Annotation>,
    pub prompts: BTreeMap<String, Prompt>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            version: 1,
            sessions: BTreeMap::new(),
            prompts: BTreeMap::new(),
        }
    }
}

pub struct Store {
    path: PathBuf,
    writes: Mutex<()>,
}

impl Default for Store {
    fn default() -> Self {
        Self::at(crate::paths::app_data_dir().join("personal-library.json"))
    }
}

fn invalid() -> Error {
    Error::Session("personal library contains unsupported or oversized values; the existing file was preserved".into())
}

fn id_valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

fn tags_valid(tags: &[String]) -> bool {
    tags.len() <= 12
        && tags.iter().all(|tag| {
            !tag.trim().is_empty() && tag.len() <= 160 && !tag.chars().any(char::is_control)
        })
}

impl Snapshot {
    fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.sessions.len() > 5000
            || self.prompts.len() > 250
            || self.sessions.iter().any(|(id, item)| {
                !id_valid(id)
                    || item.title.len() > 960
                    || item.title.chars().any(char::is_control)
                    || item.note.len() > 32 * 1024
                    || !tags_valid(&item.tags)
                    || item.bookmarks.len() > 500
                    || item
                        .bookmarks
                        .iter()
                        .any(|seq| *seq > 9_007_199_254_740_991)
            })
            || self.prompts.iter().any(|(id, item)| {
                !id_valid(id)
                    || id != &item.id
                    || item.title.trim().is_empty()
                    || item.title.len() > 960
                    || item.title.chars().any(char::is_control)
                    || item.body.trim().is_empty()
                    || item.body.len() > 128 * 1024
                    || !tags_valid(&item.tags)
            })
        {
            return Err(invalid());
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

    pub fn read(&self) -> Result<Snapshot> {
        let body = match crate::bounded_file::read(&self.path, LIMIT) {
            Ok(body) => body,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Snapshot::default())
            }
            Err(error) => {
                return Err(Error::Session(format!(
                    "could not read the personal library: {error}"
                )))
            }
        };
        let state: Snapshot = serde_json::from_slice(&body).map_err(|_| invalid())?;
        state.validate()?;
        Ok(state)
    }

    fn update(&self, change: impl FnOnce(&mut Snapshot)) -> Result<Snapshot> {
        let _guard = self.writes.lock().map_err(|_| {
            Error::Session("personal library is unavailable; restart Studio".into())
        })?;
        let mut state = self.read()?;
        change(&mut state);
        state.validate()?;
        let body = serde_json::to_vec_pretty(&state).map_err(|_| invalid())?;
        if body.len() > LIMIT {
            return Err(invalid());
        }
        crate::atomic::write(&self.path, body).map_err(|error| {
            Error::Session(format!("could not save the personal library: {error}"))
        })?;
        Ok(state)
    }

    #[cfg(test)]
    pub fn annotate(&self, id: String, annotation: Annotation) -> Result<Snapshot> {
        if !id_valid(&id) {
            return Err(invalid());
        }
        self.update(|state| {
            if annotation == Annotation::default() {
                state.sessions.remove(&id);
            } else {
                state.sessions.insert(id, annotation);
            }
        })
    }

    pub fn patch_annotation(&self, id: String, patch: AnnotationPatch) -> Result<Snapshot> {
        if !id_valid(&id) {
            return Err(invalid());
        }
        self.update(|state| {
            let item = state.sessions.entry(id.clone()).or_default();
            if let Some(title) = patch.title {
                item.title = title;
            }
            if let Some(pinned) = patch.pinned {
                item.pinned = pinned;
            }
            if let Some(tags) = patch.tags {
                item.tags = tags;
            }
            if let Some(note) = patch.note {
                item.note = note;
            }
            if let Some(bookmarks) = patch.bookmarks {
                item.bookmarks = bookmarks;
            }
            if item == &Annotation::default() {
                state.sessions.remove(&id);
            }
        })
    }

    pub fn save_prompt(&self, prompt: Prompt) -> Result<Snapshot> {
        self.update(|state| {
            state.prompts.insert(prompt.id.clone(), prompt);
        })
    }

    pub fn remove_prompt(&self, id: String) -> Result<Snapshot> {
        self.update(|state| {
            state.prompts.remove(&id);
        })
    }
}

async fn away(
    store: Arc<Store>,
    job: impl FnOnce(&Store) -> Result<Snapshot> + Send + 'static,
) -> Result<Snapshot> {
    tauri::async_runtime::spawn_blocking(move || job(&store))
        .await
        .map_err(|error| Error::Session(error.to_string()))?
}

#[tauri::command]
pub async fn library_read(store: State<'_, Arc<Store>>) -> Result<Snapshot> {
    away(Arc::clone(store.inner()), Store::read).await
}

#[tauri::command]
pub async fn session_annotate(
    store: State<'_, Arc<Store>>,
    library: State<'_, Arc<crate::sessions::Library>>,
    id: String,
    annotation: AnnotationPatch,
) -> Result<Snapshot> {
    let library = Arc::clone(library.inner());
    away(Arc::clone(store.inner()), move |store| {
        if !library.roster().cards.iter().any(|card| card.id == id) {
            return Err(Error::Session("that session is no longer on disk".into()));
        }
        store.patch_annotation(id, annotation)
    })
    .await
}

#[tauri::command]
pub async fn prompt_save(store: State<'_, Arc<Store>>, prompt: Prompt) -> Result<Snapshot> {
    away(Arc::clone(store.inner()), move |store| {
        store.save_prompt(prompt)
    })
    .await
}

#[tauri::command]
pub async fn prompt_remove(store: State<'_, Arc<Store>>, id: String) -> Result<Snapshot> {
    away(Arc::clone(store.inner()), move |store| {
        store.remove_prompt(id)
    })
    .await
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
    fn store() -> (Fixture, Store) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "dsh-library-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::at(dir.join("personal.json"));
        (Fixture(dir), store)
    }
    #[test]
    fn annotations_and_prompts_survive_reopen_and_reset() {
        let (_dir, store) = store();
        assert_eq!(store.read().unwrap(), Snapshot::default());
        let annotation = Annotation {
            title: "发布复盘".into(),
            pinned: true,
            tags: vec!["release".into()],
            note: "Keep the decision".into(),
            bookmarks: BTreeSet::from([0, 9]),
        };
        store
            .annotate("session-one".into(), annotation.clone())
            .unwrap();
        let prompt = Prompt {
            id: "prompt-one".into(),
            title: "Review".into(),
            body: "Review {{file}}".into(),
            tags: vec!["code".into()],
        };
        store.save_prompt(prompt.clone()).unwrap();
        let reopened = Store::at(store.path.clone());
        assert_eq!(reopened.read().unwrap().sessions["session-one"], annotation);
        assert_eq!(reopened.read().unwrap().prompts["prompt-one"], prompt);
        assert!(reopened
            .annotate("session-one".into(), Annotation::default())
            .unwrap()
            .sessions
            .is_empty());
        assert!(reopened
            .remove_prompt("prompt-one".into())
            .unwrap()
            .prompts
            .is_empty());
    }
    #[test]
    fn invalid_writes_preserve_the_file() {
        let (_dir, store) = store();
        store
            .annotate(
                "one".into(),
                Annotation {
                    pinned: true,
                    ..Annotation::default()
                },
            )
            .unwrap();
        let before = std::fs::read(&store.path).unwrap();
        for annotation in [
            Annotation {
                title: "a".repeat(961),
                ..Annotation::default()
            },
            Annotation {
                tags: vec!["".into()],
                ..Annotation::default()
            },
            Annotation {
                note: "a".repeat(32769),
                ..Annotation::default()
            },
            Annotation {
                bookmarks: BTreeSet::from([u64::MAX]),
                ..Annotation::default()
            },
        ] {
            assert!(store.annotate("one".into(), annotation).is_err());
            assert_eq!(std::fs::read(&store.path).unwrap(), before);
        }
        assert!(store.annotate("".into(), Annotation::default()).is_err());
        assert!(store
            .save_prompt(Prompt {
                id: "x".into(),
                title: "".into(),
                body: "x".into(),
                tags: vec![]
            })
            .is_err());
    }
    #[test]
    fn damaged_and_future_files_are_never_overwritten() {
        let (_dir, store) = store();
        for text in [
            "not json",
            "{\"version\":2,\"sessions\":{},\"prompts\":{}}",
            "{\"version\":1,\"sessions\":{},\"prompts\":{},\"unexpected\":true}",
        ] {
            std::fs::write(&store.path, text).unwrap();
            assert!(store.read().is_err());
            assert!(store.remove_prompt("x".into()).is_err());
            assert_eq!(std::fs::read_to_string(&store.path).unwrap(), text);
        }
    }
    #[test]
    fn concurrent_writers_do_not_lose_other_records() {
        let (_dir, store) = store();
        let store = Arc::new(store);
        let jobs: Vec<_> = (0..16)
            .map(|id| {
                let store = Arc::clone(&store);
                std::thread::spawn(move || {
                    store
                        .annotate(
                            format!("session-{id}"),
                            Annotation {
                                pinned: true,
                                ..Annotation::default()
                            },
                        )
                        .unwrap()
                })
            })
            .collect();
        for job in jobs {
            job.join().unwrap();
        }
        assert_eq!(store.read().unwrap().sessions.len(), 16);
    }

    #[test]
    fn partial_updates_preserve_changes_from_other_windows() {
        let (_dir, store) = store();
        store
            .patch_annotation(
                "one".into(),
                AnnotationPatch {
                    note: Some("keep".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let result = store
            .patch_annotation(
                "one".into(),
                AnnotationPatch {
                    pinned: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(result.sessions["one"].note, "keep");
        assert!(result.sessions["one"].pinned);
        store
            .patch_annotation(
                "one".into(),
                AnnotationPatch {
                    title: Some("name".into()),
                    tags: Some(vec!["tag".into()]),
                    bookmarks: Some(BTreeSet::from([1])),
                    ..Default::default()
                },
            )
            .unwrap();
        let result = store
            .patch_annotation(
                "one".into(),
                AnnotationPatch {
                    title: Some(String::new()),
                    pinned: Some(false),
                    tags: Some(vec![]),
                    note: Some(String::new()),
                    bookmarks: Some(BTreeSet::new()),
                },
            )
            .unwrap();
        assert!(result.sessions.is_empty());
    }

    #[test]
    fn collection_and_unicode_limits_are_explicit() {
        let mut state = Snapshot::default();
        state.sessions.insert(
            "one".into(),
            Annotation {
                title: "😀".repeat(240),
                tags: vec!["😀".repeat(40); 12],
                bookmarks: (0..500).collect(),
                ..Default::default()
            },
        );
        assert!(state.validate().is_ok());
        state
            .sessions
            .get_mut("one")
            .unwrap()
            .tags
            .push("extra".into());
        assert!(state.validate().is_err());
        state.sessions.get_mut("one").unwrap().tags.pop();
        state.sessions.get_mut("one").unwrap().bookmarks.insert(500);
        assert!(state.validate().is_err());
        state.sessions.clear();
        for index in 0..250 {
            let id = format!("prompt-{index}");
            state.prompts.insert(
                id.clone(),
                Prompt {
                    id,
                    title: "Review".into(),
                    body: "Body".into(),
                    tags: vec![],
                },
            );
        }
        assert!(state.validate().is_ok());
        state.prompts.insert(
            "extra".into(),
            Prompt {
                id: "extra".into(),
                title: "Review".into(),
                body: "Body".into(),
                tags: vec![],
            },
        );
        assert!(state.validate().is_err());
    }

    #[test]
    fn oversized_files_and_unwritable_locations_fail_without_replacement() {
        let (_dir, store) = store();
        std::fs::write(&store.path, vec![b' '; LIMIT + 1]).unwrap();
        assert!(store.read().is_err());
        assert!(store.remove_prompt("missing".into()).is_err());
        assert_eq!(
            std::fs::metadata(&store.path).unwrap().len(),
            (LIMIT + 1) as u64
        );
        let blocked = Store::at(store.path.join("child.json"));
        assert!(blocked
            .patch_annotation(
                "one".into(),
                AnnotationPatch {
                    pinned: Some(true),
                    ..Default::default()
                }
            )
            .is_err());
        assert!(store.path.is_file());
    }
}

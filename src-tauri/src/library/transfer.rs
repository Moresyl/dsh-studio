//! Portable personal data, reviewed before a single atomic merge.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Package {
    format: String,
    version: u8,
    prompts_only: bool,
    data: Snapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub revision: String,
    pub source_hash: String,
    pub prompts: usize,
    pub sessions: usize,
    pub conflicts: usize,
    pub names: Vec<String>,
    pub prompts_only: bool,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn revision(data: &Snapshot) -> Result<String> {
    Ok(digest(&serde_json::to_vec(data).map_err(|_| invalid())?))
}
fn package(source: &str) -> Result<Package> {
    if source.len() > LIMIT {
        return Err(invalid());
    }
    let package: Package = serde_json::from_str(source).map_err(|_| invalid())?;
    if package.format != "dsh-studio-personal-library"
        || package.version != 1
        || (package.prompts_only && !package.data.sessions.is_empty())
    {
        return Err(invalid());
    }
    package.data.validate()?;
    Ok(package)
}

impl Store {
    fn export(&self, prompts_only: bool) -> Result<String> {
        let mut data = self.read()?;
        if prompts_only {
            data.sessions.clear();
        }
        let text = serde_json::to_string_pretty(&Package {
            format: "dsh-studio-personal-library".into(),
            version: 1,
            prompts_only,
            data,
        })
        .map_err(|_| invalid())?;
        if text.len() > LIMIT {
            return Err(invalid());
        }
        Ok(text)
    }

    fn preview(&self, source: &str) -> Result<Preview> {
        let incoming = package(source)?;
        let current = self.read()?;
        Ok(Preview {
            revision: revision(&current)?,
            source_hash: digest(source.as_bytes()),
            prompts: incoming.data.prompts.len(),
            sessions: incoming.data.sessions.len(),
            conflicts: incoming
                .data
                .prompts
                .keys()
                .filter(|id| current.prompts.contains_key(*id))
                .count()
                + incoming
                    .data
                    .sessions
                    .keys()
                    .filter(|id| current.sessions.contains_key(*id))
                    .count(),
            names: incoming
                .data
                .prompts
                .values()
                .take(8)
                .map(|prompt| prompt.title.clone())
                .collect(),
            prompts_only: incoming.prompts_only,
        })
    }

    pub fn import(
        &self,
        source: &str,
        expected: &str,
        source_hash: &str,
        overwrite: bool,
    ) -> Result<Snapshot> {
        let incoming = package(source)?;
        if digest(source.as_bytes()) != source_hash {
            return Err(invalid());
        }
        let _guard = self.writes.lock().map_err(|_| invalid())?;
        let mut current = self.read()?;
        if revision(&current)? != expected {
            return Err(Error::Session(
                "personal data changed after the preview; review the import again".into(),
            ));
        }
        for (id, value) in incoming.data.sessions {
            if overwrite || !current.sessions.contains_key(&id) {
                current.sessions.insert(id, value);
            }
        }
        for (id, value) in incoming.data.prompts {
            if overwrite || !current.prompts.contains_key(&id) {
                current.prompts.insert(id, value);
            }
        }
        self.commit(current)
    }
}

#[tauri::command]
pub async fn library_export_save(
    store: State<'_, Arc<Store>>,
    path: PathBuf,
    prompts_only: bool,
) -> Result<()> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let parent = path
            .parent()
            .and_then(|parent| parent.canonicalize().ok())
            .ok_or_else(invalid)?;
        if !path.is_absolute()
            || path.extension().and_then(|ext| ext.to_str()) != Some("json")
            || crate::paths::app_data_dir()
                .canonicalize()
                .is_ok_and(|managed| parent.starts_with(managed))
            || std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink())
        {
            return Err(Error::Session(
                "choose a .json file outside Studio's managed data directory".into(),
            ));
        }
        crate::atomic::write(&path, store.export(prompts_only)?.as_bytes()).map_err(|_| {
            Error::Session(
                "could not save the personal data export at the selected location".into(),
            )
        })
    })
    .await
    .map_err(|_| invalid())?
}

#[tauri::command]
pub async fn library_import_preview(
    store: State<'_, Arc<Store>>,
    source: String,
) -> Result<Preview> {
    let store = Arc::clone(store.inner());
    tauri::async_runtime::spawn_blocking(move || store.preview(&source))
        .await
        .map_err(|_| invalid())?
}

#[tauri::command]
pub async fn library_import_apply(
    store: State<'_, Arc<Store>>,
    source: String,
    revision: String,
    source_hash: String,
    overwrite: bool,
) -> Result<Snapshot> {
    away(Arc::clone(store.inner()), move |store| {
        store.import(&source, &revision, &source_hash, overwrite)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::super::tests::store;
    use super::*;
    fn prompt(body: &str) -> Prompt {
        Prompt {
            id: "one".into(),
            title: "Review".into(),
            body: body.into(),
            tags: vec![],
        }
    }
    #[test]
    fn portable_packages_round_trip_with_explicit_conflict_policy() {
        let (_a, a) = store();
        let (_b, b) = store();
        a.save_prompt(prompt("incoming")).unwrap();
        a.patch_many(
            vec!["session".into()],
            BatchPatch {
                pinned: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        b.save_prompt(prompt("existing")).unwrap();
        let source = a.export(false).unwrap();
        let preview = b.preview(&source).unwrap();
        assert_eq!(
            (preview.prompts, preview.sessions, preview.conflicts),
            (1, 1, 1)
        );
        b.import(&source, &preview.revision, &preview.source_hash, false)
            .unwrap();
        assert_eq!(b.read().unwrap().prompts["one"].body, "existing");
        let preview = b.preview(&source).unwrap();
        b.import(&source, &preview.revision, &preview.source_hash, true)
            .unwrap();
        assert_eq!(b.read().unwrap().prompts["one"].body, "incoming");
        assert!(package(&a.export(true).unwrap())
            .unwrap()
            .data
            .sessions
            .is_empty());
    }
    #[test]
    fn stale_preview_and_modified_sources_never_write() {
        let (_a, a) = store();
        let source = a.export(false).unwrap();
        let preview = a.preview(&source).unwrap();
        a.save_prompt(prompt("new")).unwrap();
        let before = std::fs::read(&a.path).unwrap();
        assert!(a
            .import(&source, &preview.revision, &preview.source_hash, true)
            .is_err());
        let preview = a.preview(&source).unwrap();
        assert!(a
            .import(
                &(source.clone() + " "),
                &preview.revision,
                &preview.source_hash,
                true
            )
            .is_err());
        assert_eq!(std::fs::read(&a.path).unwrap(), before);
    }
    #[test]
    fn invalid_future_oversized_and_overflow_imports_preserve_data() {
        let (_a, a) = store();
        a.save_prompt(prompt("keep")).unwrap();
        let source = a.export(false).unwrap();
        let before = std::fs::read(&a.path).unwrap();
        for source in [
            "invalid".into(),
            " ".repeat(LIMIT + 1),
            source.replace("\"version\": 1", "\"version\": 2"),
            source.replace("dsh-studio-personal-library", "other"),
        ] {
            assert!(a.preview(&source).is_err());
        }
        assert_eq!(std::fs::read(&a.path).unwrap(), before);
        let (_b, b) = store();
        for index in 0..250 {
            let mut item = prompt("incoming");
            item.id = index.to_string();
            b.save_prompt(item).unwrap();
        }
        let source = b.export(true).unwrap();
        let preview = a.preview(&source).unwrap();
        assert!(a
            .import(&source, &preview.revision, &preview.source_hash, false)
            .is_err());
        assert_eq!(std::fs::read(&a.path).unwrap(), before);
    }
    #[test]
    fn batch_patch_preserves_notes_and_rolls_back_every_record_on_overflow() {
        let (_a, a) = store();
        a.patch_annotation(
            "one".into(),
            AnnotationPatch {
                note: Some("keep".into()),
                tags: Some((0..12).map(|n| n.to_string()).collect()),
                ..Default::default()
            },
        )
        .unwrap();
        let before = std::fs::read(&a.path).unwrap();
        assert!(a
            .patch_many(
                vec!["two".into(), "one".into()],
                BatchPatch {
                    pinned: Some(true),
                    add_tags: vec!["extra".into()],
                    ..Default::default()
                }
            )
            .is_err());
        assert_eq!(std::fs::read(&a.path).unwrap(), before);
        a.patch_many(
            vec!["one".into(), "two".into(), "one".into()],
            BatchPatch {
                pinned: Some(true),
                remove_tags: vec!["0".into()],
                add_tags: vec!["new".into()],
            },
        )
        .unwrap();
        assert_eq!(a.read().unwrap().sessions["one"].note, "keep");
        assert_eq!(a.read().unwrap().sessions["one"].tags.len(), 12);
        assert!(a.patch_many(vec![], BatchPatch::default()).is_err());
        assert!(a
            .patch_many(
                (0..501).map(|n| n.to_string()).collect(),
                BatchPatch::default()
            )
            .is_err());
    }
}

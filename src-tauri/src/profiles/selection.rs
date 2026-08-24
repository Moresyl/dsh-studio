//! Crash-safe profile selection with a last-known-good fallback.
//!
//! A profile click is only a candidate until its Harness reaches readiness. If
//! it cannot, the next launch must not keep choosing the same broken stack.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::paths;

const SCHEMA: u8 = 2;
const SELECTION_FILE: &str = "profile.json";
const NOTICE_FILE: &str = "profile-recovery.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    schema: u8,
    active: String,
    pending: Option<String>,
    last_known_good: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    #[serde(default)]
    schema: Option<u8>,
    #[serde(default)]
    selected: Option<String>,
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    pending: Option<String>,
    #[serde(default)]
    last_known_good: Option<String>,
}

/// Durable explanation shown after a failed candidate was contained.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNotice {
    #[serde(default)]
    pub generation: String,
    pub failed_profile: String,
    pub recovered_profile: Option<String>,
    pub reason: String,
}

#[derive(Clone)]
struct Store {
    root: PathBuf,
    profiles: PathBuf,
}

impl Store {
    fn managed() -> Self {
        Self {
            root: paths::app_data_dir(),
            profiles: paths::profiles_dir(),
        }
    }

    fn selection_path(&self) -> PathBuf {
        self.root.join(SELECTION_FILE)
    }

    fn notice_path(&self) -> PathBuf {
        self.root.join(NOTICE_FILE)
    }

    fn usable(&self, name: &str) -> bool {
        super::is_name(name) && self.profiles.join(name).is_dir()
    }

    fn fallback(&self) -> String {
        super::DEFAULT.to_string()
    }

    fn read(&self) -> State {
        let stored = std::fs::read(self.selection_path())
            .ok()
            .and_then(|body| serde_json::from_slice::<StoredState>(&body).ok());

        let Some(stored) = stored else {
            let fallback = self.fallback();
            return State {
                schema: SCHEMA,
                active: fallback.clone(),
                pending: None,
                last_known_good: fallback,
            };
        };

        // v1 contained only `selected`. It was the profile releases before this
        // one had already been running, so it is the least surprising healthy
        // baseline for a one-time migration.
        let legacy = stored.selected.filter(|name| self.usable(name));
        let active = stored
            .active
            .filter(|name| self.usable(name))
            .or_else(|| legacy.clone())
            .unwrap_or_else(|| self.fallback());
        let last_known_good = stored
            .last_known_good
            .filter(|name| self.usable(name))
            .unwrap_or_else(|| active.clone());
        let pending = stored
            .pending
            .filter(|name| self.usable(name) && name != &active);

        let _ = stored.schema;
        State {
            schema: SCHEMA,
            active,
            pending,
            last_known_good,
        }
    }

    fn write(&self, state: &State) -> Result<()> {
        write_json_atomic(&self.selection_path(), state)
    }

    fn chosen(&self) -> String {
        let state = self.read();
        state.pending.unwrap_or(state.active)
    }

    fn choose(&self, name: &str) -> Result<()> {
        if !self.usable(name) {
            return Err(Error::Profile(format!("there is no profile called {name}")));
        }
        let mut state = self.read();
        state.pending = (state.active != name).then(|| name.to_string());
        self.write(&state)
    }

    fn mark_healthy(&self, name: &str) -> Result<()> {
        if !self.usable(name) {
            return Err(Error::Profile(format!(
                "profile {name} disappeared before it could be marked healthy"
            )));
        }
        let mut state = self.read();
        // A second window may have selected another candidate while this one
        // was starting. Do not erase that newer choice.
        if state
            .pending
            .as_deref()
            .is_some_and(|pending| pending != name)
        {
            return Ok(());
        }
        state.active = name.to_string();
        state.last_known_good = name.to_string();
        state.pending = None;
        self.write(&state)
    }

    fn failed(&self, name: &str, reason: &str) -> Result<Option<String>> {
        let mut state = self.read();
        let fallback = (state.pending.as_deref() == Some(name)
            && state.last_known_good != name
            && self.usable(&state.last_known_good))
        .then(|| state.last_known_good.clone());

        if let Some(recovered) = &fallback {
            state.active = recovered.clone();
            state.pending = None;
            self.write(&state)?;
        }
        write_json_atomic(
            &self.notice_path(),
            &RecoveryNotice {
                generation: generation(name, reason),
                failed_profile: name.to_string(),
                recovered_profile: fallback.clone(),
                reason: reason.to_string(),
            },
        )?;
        Ok(fallback)
    }

    fn rename(&self, from: &str, to: &str) -> Result<()> {
        let mut state = self.read();
        replace(&mut state.active, from, to);
        replace(&mut state.last_known_good, from, to);
        if state.pending.as_deref() == Some(from) {
            state.pending = Some(to.to_string());
        }
        self.write(&state)
    }

    fn remove(&self, name: &str) -> Result<()> {
        let mut state = self.read();
        let fallback = self.fallback();
        if state.active == name {
            state.active = fallback.clone();
        }
        if state.last_known_good == name {
            state.last_known_good = state.active.clone();
        }
        if state.pending.as_deref() == Some(name) {
            state.pending = None;
        }
        self.write(&state)
    }
}

fn generation(profile: &str, reason: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seed = format!("{}\0{}\0{}\0{}", std::process::id(), now, profile, reason);
    hex(&Sha256::digest(seed.as_bytes()))
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

fn replace(slot: &mut String, from: &str, to: &str) {
    if slot == from {
        *slot = to.to_string();
    }
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|cause| {
            Error::Profile(format!(
                "{} could not be created: {cause}",
                parent.display()
            ))
        })?;
    }
    let mut body = serde_json::to_vec_pretty(value)
        .map_err(|cause| Error::Profile(format!("profile state could not be encoded: {cause}")))?;
    body.push(b'\n');
    crate::atomic::write(path, body).map_err(|cause| {
        Error::Profile(format!(
            "{} could not be committed: {cause}",
            path.display()
        ))
    })
}

pub fn chosen() -> String {
    Store::managed().chosen()
}

pub fn choose(name: &str) -> Result<()> {
    Store::managed().choose(name)
}

pub fn mark_healthy(name: &str) -> Result<()> {
    Store::managed().mark_healthy(name)
}

pub fn failed(name: &str, reason: &str) -> Result<Option<String>> {
    Store::managed().failed(name, reason)
}

pub fn rename(from: &str, to: &str) -> Result<()> {
    Store::managed().rename(from, to)
}

pub fn remove(name: &str) -> Result<()> {
    Store::managed().remove(name)
}

pub fn notice() -> Option<RecoveryNotice> {
    let store = Store::managed();
    std::fs::read(store.notice_path())
        .ok()
        .and_then(|body| serde_json::from_slice(&body).ok())
}

pub fn acknowledge() -> Result<()> {
    let path = Store::managed().notice_path();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(cause) => Err(Error::Profile(format!(
            "{} could not be removed: {cause}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> (Store, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "dsh-studio-profile-selection-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let store = Store {
            root: base.join("state"),
            profiles: base.join("profiles"),
        };
        std::fs::create_dir_all(store.profiles.join("web")).expect("web profile");
        (store, base)
    }

    #[test]
    fn a_candidate_is_not_good_until_it_reaches_readiness() {
        let (store, base) = store("pending");
        std::fs::create_dir_all(store.profiles.join("work")).expect("work profile");

        store.choose("work").expect("choose");
        assert_eq!(store.chosen(), "work");
        let state = store.read();
        assert_eq!(state.active, "web");
        assert_eq!(state.last_known_good, "web");
        assert_eq!(state.pending.as_deref(), Some("work"));

        store.mark_healthy("work").expect("healthy");
        let state = store.read();
        assert_eq!(state.active, "work");
        assert_eq!(state.last_known_good, "work");
        assert!(state.pending.is_none());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_failed_candidate_rolls_back_and_leaves_a_notice() {
        let (store, base) = store("rollback");
        std::fs::create_dir_all(store.profiles.join("broken")).expect("broken profile");
        store.choose("broken").expect("choose");

        assert_eq!(
            store.failed("broken", "bundle failed").unwrap(),
            Some("web".into())
        );
        assert_eq!(store.chosen(), "web");
        let notice: RecoveryNotice =
            serde_json::from_slice(&std::fs::read(store.notice_path()).expect("notice"))
                .expect("valid notice");
        assert_eq!(notice.failed_profile, "broken");
        assert_eq!(notice.recovered_profile.as_deref(), Some("web"));
        assert_eq!(notice.generation.len(), 64);
        assert!(notice
            .generation
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn the_old_selected_shape_migrates_as_a_healthy_baseline() {
        let (store, base) = store("migration");
        std::fs::create_dir_all(store.profiles.join("work")).expect("work profile");
        std::fs::create_dir_all(&store.root).expect("state dir");
        std::fs::write(store.selection_path(), "{\"selected\":\"work\"}").expect("legacy");

        let state = store.read();
        assert_eq!(state.active, "work");
        assert_eq!(state.last_known_good, "work");
        assert!(state.pending.is_none());
        let _ = std::fs::remove_dir_all(base);
    }
}

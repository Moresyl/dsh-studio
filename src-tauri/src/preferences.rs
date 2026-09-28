//! Origin-independent, bounded desktop presentation preferences.
//!
//! The shell uses a different loopback port at each start. Web storage alone
//! cannot remember settings across those origins. Only known non-secret keys
//! are mirrored; plugin storage, credentials and arbitrary paths stay out.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::error::{Error, Result};

type Preferences = BTreeMap<String, String>;
const FILE_LIMIT: usize = 512 * 1024;
const VALUE_LIMIT: usize = 64 * 1024;
static WRITES: Mutex<()> = Mutex::new(());
static BOOT_ID: OnceLock<String> = OnceLock::new();

fn valid(key: &str, value: &str) -> bool {
    if value.len() > VALUE_LIMIT {
        return false;
    }
    match key {
        "dsh-studio.theme" => matches!(value, "system" | "light" | "dark"),
        "dsh-studio.presentation" => matches!(value, "compatibility" | "extended" | "advanced"),
        "dsh-studio.sidebar" => matches!(value, "collapsed" | "open"),
        "dsh-studio.onboarding" => {
            value.len() <= 8 && !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
        }
        "dsh-studio:terminal-layout:v1" => matches!(value, "single" | "columns" | "rows" | "grid"),
        "dsh-studio:update:dismissed" => {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
        }
        "dsh-studio:usage:rates:v1" => {
            serde_json::from_str::<serde_json::Value>(value).is_ok_and(|v| v.is_object())
        }
        _ => false,
    }
}

fn read(path: &Path) -> Result<Preferences> {
    let body = match crate::bounded_file::read(path, FILE_LIMIT) {
        Ok(body) => body,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(Preferences::new()),
        Err(cause) => {
            return Err(Error::Window(format!(
                "could not read desktop preferences: {cause}"
            )))
        }
    };
    let values: Preferences = serde_json::from_slice(&body).map_err(|_| {
        Error::Window("desktop preferences are damaged; the existing file was preserved".into())
    })?;
    if values.iter().any(|(key, value)| !valid(key, value)) {
        return Err(Error::Window(
            "desktop preferences contain unsupported values; the existing file was preserved"
                .into(),
        ));
    }
    Ok(values)
}

fn save(path: &Path, key: String, value: String) -> Result<()> {
    if !valid(&key, &value) {
        return Err(Error::Window(
            "unsupported desktop preference or value".into(),
        ));
    }
    let _guard = WRITES
        .lock()
        .map_err(|_| Error::Window("desktop preference storage is unavailable".into()))?;
    let mut values = read(path)?;
    values.insert(key, value);
    let body = serde_json::to_vec(&values).map_err(|cause| Error::Window(cause.to_string()))?;
    if body.len() > FILE_LIMIT {
        return Err(Error::Window(
            "desktop preferences exceed their storage limit".into(),
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|cause| {
            Error::Window(format!(
                "could not create desktop preference storage: {cause}"
            ))
        })?;
    }
    crate::atomic::write(path, body)
        .map_err(|cause| Error::Window(format!("could not save desktop preferences: {cause}")))
}

#[tauri::command]
pub async fn preference_save(key: String, value: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        save(
            &crate::paths::app_data_dir().join("preferences.json"),
            key,
            value,
        )
    })
    .await
    .map_err(|cause| Error::Window(format!("desktop preference task failed: {cause}")))?
}

/// Runs only in the trusted shell document, before the UI reads any settings.
pub fn bootstrap(origin: &str) -> String {
    let values =
        read(&crate::paths::app_data_dir().join("preferences.json")).unwrap_or_else(|cause| {
            eprintln!("[preferences] {cause}");
            Preferences::new()
        });
    bootstrap_values(origin, &values)
}

fn bootstrap_values(origin: &str, values: &Preferences) -> String {
    let boot = BOOT_ID.get_or_init(|| {
        format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        )
    });
    let origin = serde_json::to_string(origin).expect("string serializes");
    let values = serde_json::to_string(values).expect("string map serializes");
    let boot = serde_json::to_string(boot).expect("string serializes");
    let script = include_str!("preferences-bootstrap.js");
    format!("({script})({origin}, {values}, {boot});")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn fixture() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "dsh-preferences-{}-{}.json",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn saves_merge_and_survive_a_fresh_read() {
        let path = fixture();
        save(&path, "dsh-studio.theme".into(), "light".into()).unwrap();
        save(&path, "dsh-studio:terminal-layout:v1".into(), "grid".into()).unwrap();
        let restored = read(&path).unwrap();
        assert_eq!(restored["dsh-studio.theme"], "light");
        assert_eq!(restored["dsh-studio:terminal-layout:v1"], "grid");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_unknown_keys_and_invalid_or_oversized_values() {
        let path = fixture();
        for (key, value) in [
            ("api-key", "secret"),
            ("../theme", "light"),
            ("dsh-studio.theme", "invalid"),
            ("dsh-studio:usage:rates:v1", "[]"),
        ] {
            assert!(save(&path, key.into(), value.into()).is_err());
        }
        assert!(!valid(
            "dsh-studio:usage:rates:v1",
            &"x".repeat(VALUE_LIMIT + 1)
        ));
        assert!(!path.exists());
    }

    #[test]
    fn damaged_storage_is_not_overwritten() {
        let path = fixture();
        std::fs::write(&path, b"{broken").unwrap();
        assert!(save(&path, "dsh-studio.theme".into(), "dark".into()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn concurrent_windows_do_not_lose_unrelated_keys() {
        let path = fixture();
        let first = path.clone();
        let second = path.clone();
        let a = std::thread::spawn(move || save(&first, "dsh-studio.theme".into(), "dark".into()));
        let b = std::thread::spawn(move || {
            save(&second, "dsh-studio.sidebar".into(), "collapsed".into())
        });
        a.join().unwrap().unwrap();
        b.join().unwrap().unwrap();
        let values = read(&path).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values["dsh-studio.theme"], "dark");
        assert_eq!(values["dsh-studio.sidebar"], "collapsed");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn foreign_or_oversized_files_are_preserved() {
        let path = fixture();
        for body in [
            br#"{"api-key":"not-a-preference"}"#.to_vec(),
            vec![b' '; FILE_LIMIT + 1],
        ] {
            std::fs::write(&path, &body).unwrap();
            assert!(read(&path).is_err());
            assert!(save(&path, "dsh-studio.theme".into(), "light".into()).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), body);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn validates_every_supported_preference() {
        for (key, value) in [
            ("dsh-studio.presentation", "advanced"),
            ("dsh-studio.sidebar", "collapsed"),
            ("dsh-studio.onboarding", "1"),
            ("dsh-studio:update:dismissed", "0.9.18"),
            (
                "dsh-studio:usage:rates:v1",
                r#"{"rates":{},"currency":"CNY"}"#,
            ),
        ] {
            assert!(valid(key, value));
        }
        assert!(!valid("dsh-studio.onboarding", ""));
        assert!(!valid("dsh-studio:update:dismissed", "<script>"));
    }

    #[test]
    fn bootstrap_is_scoped_to_the_exact_top_level_origin() {
        let source = bootstrap_values("http://127.0.0.1:1234", &Preferences::new());
        assert!(source.contains("window.top !== window.self"));
        assert!(source.contains("location.origin !== origin"));
        assert!(source.contains("\"http://127.0.0.1:1234\""));
        assert!(source.contains("__DSH_SAVED_PREFERENCES__"));
    }
}

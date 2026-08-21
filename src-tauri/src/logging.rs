//! Durable, bounded and secret-scrubbed desktop evidence.

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use regex::Regex;

use crate::harness::supervisor::Stream;

const RETAIN_LOGS: usize = 14;
const RETAIN_CRASHES: usize = 5;
const REDACTED: &str = "[REDACTED]";

static NAMED_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)(\s*[:=]\s*)([\"']?)[^\"',;\s}\]]+"#,
    )
    .expect("secret pattern")
});
static AUTH_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+").expect("authorization pattern")
});
static QUERY_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([?&](?:token|key|code|secret|password|api[_-]?key)=)[^&#\s]+")
        .expect("query secret pattern")
});

/// One process-lifetime log file. Failure to open it never prevents startup.
pub struct PersistentLog {
    path: Option<PathBuf>,
    file: Option<File>,
}

impl PersistentLog {
    pub fn managed() -> Self {
        Self::open(&crate::paths::logs_dir())
    }

    fn open(root: &Path) -> Self {
        if std::fs::create_dir_all(root).is_err() {
            return Self {
                path: None,
                file: None,
            };
        }
        prune(root, "dsh-studio-", ".log", RETAIN_LOGS);
        prune(root, "crash-", ".txt", RETAIN_CRASHES);

        let stamp = crate::sessions::export::stamp(now_millis()).replace([':', 'T', 'Z'], "-");
        let path = root.join(format!("dsh-studio-{stamp}-{}.log", std::process::id()));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        Self {
            path: file.as_ref().map(|_| path),
            file,
        }
    }

    pub fn write(&mut self, stream: Stream, line: &str) {
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let stream = match stream {
            Stream::Stdout => "out",
            Stream::Stderr => "err",
        };
        let line = redact_secrets(line);
        let _ = writeln!(
            file,
            "{} [{stream}] {line}",
            crate::sessions::export::stamp(now_millis())
        );
        let _ = file.flush();
    }

    pub fn path(&self) -> Option<PathBuf> {
        self.path.clone()
    }
}

/// Install local-only panic evidence before application setup begins.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_crash(info);
        previous(info);
    }));
}

pub fn crash_files() -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(crate::paths::logs_dir()) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let name = entry.file_name();
            let name = name.to_str()?;
            (metadata.is_file() && name.starts_with("crash-") && name.ends_with(".txt"))
                .then(|| entry.path())
        })
        .collect();
    paths.sort();
    paths.reverse();
    paths.truncate(RETAIN_CRASHES);
    paths
}

/// Remove common credentials before a log line is persisted or exported.
pub fn redact_secrets(text: &str) -> String {
    // Handle the authorization scheme and value before the generic named rule
    // can redact only the word `Bearer` and leave the credential behind.
    let auth = AUTH_VALUE.replace_all(text, |captures: &regex::Captures<'_>| {
        format!("{} {REDACTED}", &captures[1])
    });
    let named = NAMED_SECRET.replace_all(&auth, |captures: &regex::Captures<'_>| {
        format!(
            "{}{}{}{}",
            &captures[1], &captures[2], &captures[3], REDACTED
        )
    });
    QUERY_SECRET
        .replace_all(&named, |captures: &regex::Captures<'_>| {
            format!("{}{REDACTED}", &captures[1])
        })
        .into_owned()
}

fn write_crash(info: &std::panic::PanicHookInfo<'_>) {
    let root = crate::paths::logs_dir();
    if std::fs::create_dir_all(&root).is_err() {
        return;
    }
    let stamp = crate::sessions::export::stamp(now_millis()).replace([':', 'T', 'Z'], "-");
    let path = root.join(format!("crash-{stamp}-{}.txt", std::process::id()));
    let payload = info
        .payload()
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic");
    let location = info
        .location()
        .map(|location| format!("{}:{}", location.file(), location.line()))
        .unwrap_or_else(|| "unknown".to_string());
    let body = format!(
        "DSH Studio local crash evidence\ntime={}\nlocation={}\nmessage={}\n",
        crate::sessions::export::stamp(now_millis()),
        location,
        redact_secrets(payload)
    );
    let _ = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(body.as_bytes()));
}

fn prune(root: &Path, prefix: &str, suffix: &str, keep: usize) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            let name = entry.file_name();
            let name = name.to_str()?;
            (kind.is_file()
                && !kind.is_symlink()
                && name.starts_with(prefix)
                && name.ends_with(suffix))
            .then(|| entry.path())
        })
        .collect();
    files.sort();
    let remove = files.len().saturating_sub(keep);
    for path in files.into_iter().take(remove) {
        let _ = std::fs::remove_file(path);
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::redact_secrets;

    #[test]
    fn removes_headers_json_values_and_query_credentials() {
        let raw = "Authorization: Bearer abc.def Cookie=session=123 api_key=sk-secret https://x/?code=pairing&ok=1";
        let clean = redact_secrets(raw);
        assert!(!clean.contains("abc.def"));
        assert!(!clean.contains("session=123"));
        assert!(!clean.contains("sk-secret"));
        assert!(!clean.contains("pairing"));
        assert!(clean.contains("ok=1"));
    }

    #[test]
    fn ordinary_diagnostic_text_is_unchanged() {
        let line = "ERR_PNPM_FETCH_404 package was not found";
        assert_eq!(redact_secrets(line), line);
    }
}

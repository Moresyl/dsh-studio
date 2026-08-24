//! Durable, bounded and secret-scrubbed desktop evidence.

use std::backtrace::Backtrace;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::harness::supervisor::Stream;

const RETAIN_CRASHES: usize = 5;
const MAX_LOG_FILE_BYTES: u64 = 10 << 20;
const MAX_LOG_DIRECTORY_BYTES: u64 = 200 << 20;
const MAX_LOG_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const REDACTED: &str = "[REDACTED]";
static CRASH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

/// Minimum severity persisted to disk. The in-window activity stream is never
/// filtered, so changing this cannot make live failures disappear.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" => Ok(Self::Warn),
            "error" => Ok(Self::Error),
            _ => Err(Error::Report("the log level is not supported".into())),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    level: LogLevel,
}

/// One process-lifetime log, split before a single file becomes unwieldy.
/// Failure to open or rotate it never prevents startup.
pub struct PersistentLog {
    root: PathBuf,
    stem: String,
    segment: u32,
    bytes: u64,
    level: LogLevel,
    path: Option<PathBuf>,
    file: Option<File>,
}

impl PersistentLog {
    pub fn managed() -> Self {
        Self::open(&crate::paths::logs_dir(), SystemTime::now())
    }

    fn open(root: &Path, now: SystemTime) -> Self {
        let level = read_level();
        let stamp =
            crate::sessions::export::stamp(system_millis(now)).replace([':', 'T', 'Z'], "-");
        let mut log = Self {
            root: root.to_path_buf(),
            stem: format!("dsh-studio-{stamp}-{}", std::process::id()),
            segment: 0,
            bytes: 0,
            level,
            path: None,
            file: None,
        };
        if std::fs::create_dir_all(root).is_ok() {
            prune_logs(root, now);
            prune_by_name(root, "crash-", ".txt", RETAIN_CRASHES);
            prune_by_name(root, "crash-", ".dmp", RETAIN_CRASHES);
            log.open_segment();
        }
        log
    }

    pub fn set_level(&mut self, level: LogLevel) -> Result<()> {
        write_level(level)?;
        self.level = level;
        Ok(())
    }

    pub fn write(&mut self, stream: Stream, line: &str) {
        let (severity, stream) = match stream {
            Stream::Stdout => (LogLevel::Info, "out"),
            Stream::Stderr => (LogLevel::Error, "err"),
        };
        if severity < self.level {
            return;
        }

        let line = redact_secrets(line);
        let record = format!(
            "{} [{}] [{stream}] {line}\n",
            crate::sessions::export::stamp(now_millis()),
            severity.as_str()
        );
        if self.bytes > 0 && self.bytes.saturating_add(record.len() as u64) > MAX_LOG_FILE_BYTES {
            self.rotate();
        }
        let Some(file) = self.file.as_mut() else {
            return;
        };
        if file.write_all(record.as_bytes()).is_ok() {
            self.bytes = self.bytes.saturating_add(record.len() as u64);
            let _ = file.flush();
        }
    }

    pub fn path(&self) -> Option<PathBuf> {
        self.path.clone()
    }

    fn rotate(&mut self) {
        self.file.take();
        self.path.take();
        self.bytes = 0;
        self.segment = self.segment.saturating_add(1);
        prune_logs(&self.root, SystemTime::now());
        self.open_segment();
    }

    fn open_segment(&mut self) {
        // A crashed previous process can leave the same millisecond and PID
        // behind on a fast restart. Increment until the new log owns a name.
        for _ in 0..100 {
            let path = self
                .root
                .join(format!("{}-{:03}.log", self.stem, self.segment));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    self.path = Some(path);
                    self.file = Some(file);
                    return;
                }
                Err(cause) if cause.kind() == std::io::ErrorKind::AlreadyExists => {
                    self.segment = self.segment.saturating_add(1);
                }
                Err(_) => return,
            }
        }
    }
}

pub fn configured_level() -> LogLevel {
    read_level()
}

/// Install local-only panic evidence before application setup begins.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_crash(info);
        previous(info);
    }));
}

/// Crash evidence that can be attached to a diagnostic archive. This includes
/// Studio-owned panic records and platform crash reports already written by the
/// operating system; it never enables global crash upload or telemetry.
pub fn crash_files() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    collect_crashes(&crate::paths::logs_dir(), &mut paths, |name| {
        name.starts_with("crash-") && (name.ends_with(".txt") || name.ends_with(".dmp"))
    });

    #[cfg(windows)]
    if let Some(local) = dirs::data_local_dir() {
        collect_crashes(&local.join("CrashDumps"), &mut paths, |name| {
            name.to_ascii_lowercase().starts_with("dsh-studio") && name.ends_with(".dmp")
        });
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        collect_crashes(
            &home.join("Library/Logs/DiagnosticReports"),
            &mut paths,
            |name| {
                let lower = name.to_ascii_lowercase();
                lower.starts_with("dsh studio")
                    && (lower.ends_with(".crash") || lower.ends_with(".ips"))
            },
        );
    }

    paths.sort_by_key(|path| modified(path));
    paths.reverse();
    paths.truncate(RETAIN_CRASHES);
    paths
}

/// Persistent log files, newest first, for bounded diagnostic collection.
pub fn log_files() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let Ok(entries) = std::fs::read_dir(crate::paths::logs_dir()) else {
        return paths;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if kind.is_file()
            && !kind.is_symlink()
            && name.starts_with("dsh-studio-")
            && name.ends_with(".log")
        {
            paths.push(entry.path());
        }
    }
    paths.sort_by_key(|path| modified(path));
    paths.reverse();
    paths
}

/// Record an uncaught WebView error locally. The browser supplies only text;
/// paths and credentials are removed before it reaches disk.
pub fn write_frontend_crash(message: &str, stack: &str, url: &str) -> Result<()> {
    write_frontend_crash_into(&crate::paths::logs_dir(), message, stack, url)
}

fn write_frontend_crash_into(root: &Path, message: &str, stack: &str, url: &str) -> Result<()> {
    const FIELD_CEILING: usize = 32 << 10;
    std::fs::create_dir_all(root)
        .map_err(|cause| Error::Report(format!("could not create crash evidence: {cause}")))?;
    let stamp = crate::sessions::export::stamp(now_millis()).replace([':', 'T', 'Z'], "-");
    let sequence = CRASH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = root.join(format!(
        "crash-webview-{stamp}-{}-{sequence:04}.txt",
        std::process::id()
    ));
    let body = format!(
        "DSH Studio WebView crash evidence\ntime={}\nurl={}\nmessage={}\nstack=\n{}\n",
        crate::sessions::export::stamp(now_millis()),
        url.chars().take(2_048).collect::<String>(),
        message.chars().take(FIELD_CEILING).collect::<String>(),
        stack.chars().take(FIELD_CEILING).collect::<String>()
    );
    let body = redact_secrets(&body);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(body.as_bytes()))
        .map_err(|cause| {
            Error::Report(format!("could not save WebView crash evidence: {cause}"))
        })?;
    prune_by_name(root, "crash-", ".txt", RETAIN_CRASHES);
    Ok(())
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

fn settings_file() -> PathBuf {
    crate::paths::app_data_dir().join("logging.json")
}

fn read_level() -> LogLevel {
    std::fs::read(settings_file())
        .ok()
        .and_then(|raw| serde_json::from_slice::<Settings>(&raw).ok())
        .unwrap_or_default()
        .level
}

fn write_level(level: LogLevel) -> Result<()> {
    write_level_at(&settings_file(), level)
}

fn write_level_at(path: &Path, level: LogLevel) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|cause| Error::Report(format!("could not create log settings: {cause}")))?;
    }
    let raw = serde_json::to_vec(&Settings { level })
        .map_err(|cause| Error::Report(format!("could not encode log settings: {cause}")))?;
    crate::atomic::write(path, raw)
        .map_err(|cause| Error::Report(format!("could not save log settings: {cause}")))
}

fn write_crash(info: &std::panic::PanicHookInfo<'_>) {
    let root = crate::paths::logs_dir();
    if std::fs::create_dir_all(&root).is_err() {
        return;
    }
    let stamp = crate::sessions::export::stamp(now_millis()).replace([':', 'T', 'Z'], "-");
    let sequence = CRASH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let suffix = format!("{}-{sequence:04}", std::process::id());
    let path = root.join(format!("crash-{stamp}-{suffix}.txt"));
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
        "DSH Studio local crash evidence\ntime={}\nlocation={}\nmessage={}\nbacktrace=\n{}\n",
        crate::sessions::export::stamp(now_millis()),
        location,
        redact_secrets(payload),
        Backtrace::force_capture()
    );
    let _ = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(body.as_bytes()));
    write_native_dump(&root, &stamp, &suffix);
}

#[cfg(windows)]
fn write_native_dump(root: &Path, stamp: &str, suffix: &str) {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::System::Diagnostics::Debug::{MiniDumpNormal, MiniDumpWriteDump};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId};

    let path = root.join(format!("crash-{stamp}-{suffix}.dmp"));
    let Ok(file) = OpenOptions::new().write(true).create_new(true).open(&path) else {
        return;
    };
    // SAFETY: all three handles belong to this process and stay live for the
    // duration of the call; null optional structures request an ordinary dump.
    let written = unsafe {
        MiniDumpWriteDump(
            GetCurrentProcess(),
            GetCurrentProcessId(),
            file.as_raw_handle(),
            MiniDumpNormal,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if written == 0 {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(not(windows))]
fn write_native_dump(_root: &Path, _stamp: &str, _suffix: &str) {}

fn collect_crashes<F>(root: &Path, paths: &mut Vec<PathBuf>, accepts: F)
where
    F: Fn(&str) -> bool,
{
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if kind.is_file() && !kind.is_symlink() && accepts(&name) {
            paths.push(entry.path());
        }
    }
}

fn prune_logs(root: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !kind.is_file()
            || kind.is_symlink()
            || !name.starts_with("dsh-studio-")
            || !name.ends_with(".log")
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let changed = metadata.modified().unwrap_or(UNIX_EPOCH);
        if now.duration_since(changed).unwrap_or_default() > MAX_LOG_AGE {
            let _ = std::fs::remove_file(entry.path());
        } else {
            files.push((changed, metadata.len(), entry.path()));
        }
    }

    files.sort_by_key(|(changed, _, _)| *changed);
    let mut total: u64 = files.iter().map(|(_, bytes, _)| bytes).sum();
    for (_, bytes, path) in files {
        if total <= MAX_LOG_DIRECTORY_BYTES {
            break;
        }
        if std::fs::remove_file(path).is_ok() {
            total = total.saturating_sub(bytes);
        }
    }
}

fn prune_by_name(root: &Path, prefix: &str, suffix: &str, keep: usize) {
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

fn modified(path: &Path) -> SystemTime {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .unwrap_or(UNIX_EPOCH)
}

fn system_millis(now: SystemTime) -> i64 {
    now.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn now_millis() -> i64 {
    system_millis(SystemTime::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-logging-{label}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

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

    #[test]
    fn level_parser_is_closed_to_the_public_vocabulary() {
        for value in ["debug", "info", "warn", "error"] {
            assert_eq!(LogLevel::parse(value).unwrap().as_str(), value);
        }
        assert!(LogLevel::parse("trace").is_err());
        assert!(LogLevel::parse("").is_err());
    }

    #[test]
    fn log_level_settings_can_be_replaced_more_than_once() {
        let root = root("level-settings");
        let path = root.join("logging.json");

        write_level_at(&path, LogLevel::Warn).expect("first setting");
        write_level_at(&path, LogLevel::Error).expect("replacement setting");

        let saved: Settings =
            serde_json::from_slice(&std::fs::read(&path).expect("settings file")).expect("json");
        assert_eq!(saved.level, LogLevel::Error);
        std::fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn a_file_rotates_before_crossing_the_size_ceiling() {
        let root = root("rotate");
        let mut log = PersistentLog::open(&root, SystemTime::now());
        log.bytes = MAX_LOG_FILE_BYTES - 4;
        log.write(Stream::Stdout, "longer than four bytes");
        assert_eq!(log.segment, 1);
        assert!(log.bytes < 100);
        assert_eq!(log_files_in(&root).len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn error_level_keeps_stderr_and_drops_stdout() {
        let root = root("level");
        let mut log = PersistentLog::open(&root, SystemTime::now());
        log.level = LogLevel::Error;
        let path = log.path().unwrap();
        log.write(Stream::Stdout, "ordinary output");
        log.write(Stream::Stderr, "failure output");
        let text = std::fs::read_to_string(path).unwrap();
        assert!(!text.contains("ordinary output"));
        assert!(text.contains("failure output"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_logs_are_removed_before_a_new_session_opens() {
        let root = root("age");
        let old = root.join("dsh-studio-old.log");
        std::fs::write(&old, "old").unwrap();
        let future = SystemTime::now() + MAX_LOG_AGE + Duration::from_secs(1);
        let log = PersistentLog::open(&root, future);
        assert!(!old.exists());
        assert!(log.path().is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn frontend_crashes_are_bounded_redacted_and_retained() {
        let root = root("webview-crash");
        for index in 0..RETAIN_CRASHES + 2 {
            write_frontend_crash_into(
                &root,
                &format!("failure {index} Authorization: Bearer private"),
                &"stack".repeat(20_000),
                "http://127.0.0.1/?token=pairing",
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        let files: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().collect();
        assert_eq!(files.len(), RETAIN_CRASHES);
        let latest = std::fs::read_to_string(files.last().unwrap().path()).unwrap();
        assert!(!latest.contains("private"));
        assert!(!latest.contains("pairing"));
        assert!(latest.len() < 70_000);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn native_dump_writer_creates_a_real_minidump() {
        let root = root("native-dump");
        write_native_dump(&root, "test", "current-process");
        let dump = root.join("crash-test-current-process.dmp");
        let bytes = std::fs::read(&dump).unwrap();
        assert!(bytes.len() > 32);
        assert_eq!(&bytes[..4], b"MDMP");
        std::fs::remove_dir_all(root).unwrap();
    }

    fn log_files_in(root: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(root)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|extension| extension.to_str()) == Some("log"))
            .collect()
    }
}

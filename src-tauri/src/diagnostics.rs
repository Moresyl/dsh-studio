//! One button that answers "what happened on your machine?".
//!
//! A crash on somebody else's computer is invisible from here, and the thread
//! that follows it is a dozen messages of asking for facts one at a time —
//! version, runtime, profile, and then the log line that actually said what went
//! wrong. So the shell writes that thread's first reply itself: everything it
//! already knows about its own install, ending in the tail of the harness log,
//! in one document to paste or attach.
//!
//! Two decisions shape it. It is Markdown, because it is going into an issue and
//! a plain-text dump loses every line break the moment it is pasted into one.
//! And the home directory is taken out of the finished text rather than out of
//! each field, because most of the paths in here were never constructed by this
//! module — they came out of the log, where npm and the harness put them.

use std::fmt::Write as _;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::harness::commands::AppState;
use crate::harness::supervisor::{Status, Stream, Supervisor};
use crate::harness::Environment;
use crate::plugins::{InstalledPlugin, PluginState};
use crate::remote::Remote;
// The exporter's clock rather than a second one: both write a moment that has to
// mean the same thing on the machine reading it as on the machine that wrote it.
use crate::sessions::export::stamp;

/// What the home directory is written as once it is taken out.
const MASK: &str = "~";

/// Lines of harness output the report carries.
///
/// The ring holds far more, and the rest of it is rarely the part that explains
/// anything: whatever went wrong was at the end of the run.
const LOG_LINES: usize = 300;

/// How much of the log may be carried, whatever the line count says.
///
/// One line of a stack trace can be longer than a hundred ordinary ones, and an
/// issue body refused for length helps nobody.
const LOG_CEILING: usize = 32 << 10;

/// One support package is intentionally small enough to inspect and attach.
const ARCHIVE_CEILING: u64 = 50 << 20;
const ARCHIVE_ENTRY_CEILING: u64 = 20 << 20;
const ARCHIVE_MAX_FILES: usize = 64;

/// A finished report, and what to call the file it should go in.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The filename to offer, which the save dialog may well have overridden.
    pub name: String,
    /// Support package filename, separate because it carries binary evidence.
    pub archive_name: String,
    pub text: String,
}

/// Build the report, without deciding yet where it goes.
///
/// Off the runtime for the same reason the session commands are: this asks every
/// Node runtime on the machine for its version, and doing that on a runtime
/// worker would stall everything else the app is waiting on.
#[tauri::command]
pub async fn report_build(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    remote: State<'_, Arc<Remote>>,
) -> Result<Report> {
    let version = app.package_info().version.to_string();
    let supervisor = Arc::clone(&state.supervisor);
    // Whether the door is open, and nothing else about it. The pairing code and
    // the device credentials behind it are the two things in this application
    // that must never reach a public issue.
    let door = remote.is_open();

    tokio::task::spawn_blocking(move || compose(&version, &supervisor, door))
        .await
        .map_err(|cause| Error::Report(format!("building the report failed: {cause}")))
}

/// The same document, put where the user pointed.
///
/// Rust does the writing rather than the webview because the shell holds no
/// filesystem permission at all — the only path it can name is the one the
/// system's own save dialog just returned.
#[tauri::command]
pub async fn report_save(path: String, text: String) -> Result<()> {
    tokio::task::spawn_blocking(move || crate::atomic::write(Path::new(&path), text))
        .await
        .map_err(|cause| Error::Report(format!("writing the report failed: {cause}")))?
        .map_err(|cause| Error::Report(format!("writing the report failed: {cause}")))
}

/// Save the same public-safe report together with bounded local evidence.
///
/// Logs and textual crash records are redacted again while being copied. Native
/// minidumps are binary memory evidence and cannot be safely rewritten, so the
/// UI tells the user to review the archive before sharing it.
#[tauri::command]
pub async fn report_archive(path: String, text: String) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let logs = crate::logging::log_files();
        let crashes = crate::logging::crash_files();
        write_archive(Path::new(&path), &text, &logs, &crashes)
    })
    .await
    .map_err(|cause| Error::Report(format!("building the diagnostic archive failed: {cause}")))?
}

/// Local-only sink for uncaught WebView failures. It deliberately returns no
/// path, because renderer code should not gain filesystem authority from an
/// error reporting hook.
#[tauri::command]
pub fn report_frontend_crash(
    window: tauri::WebviewWindow,
    message: String,
    stack: String,
    url: String,
) -> Result<()> {
    crate::logging::write_frontend_crash(&message, &stack, &url)?;
    crate::recovery::renderer_failed(&window, &message);
    Ok(())
}

/// Export the evidence already on disk without constructing any application state.
///
/// This is deliberately synchronous and Tauri-free: it is called when startup is
/// broken badly enough that no runtime, Harness process or recovery window should
/// be trusted to exist.
pub(crate) fn export_headless(version: &str) -> Result<PathBuf> {
    let taken = stamp(now_millis());
    let directory = headless_export_directory()?;
    let destination = directory.join(headless_archive_name(&taken));
    let logs = crate::logging::log_files();
    let crashes = crate::logging::crash_files();
    let report = headless_report(version, &taken, logs.len(), crashes.len());
    write_archive(&destination, &report, &logs, &crashes)?;
    Ok(destination)
}

fn headless_export_directory() -> Result<PathBuf> {
    if let Some(downloads) = dirs::download_dir().filter(|path| real_directory(path)) {
        return Ok(downloads);
    }
    let fallback = crate::paths::app_data_dir();
    std::fs::create_dir_all(&fallback).map_err(|cause| {
        Error::Report(format!(
            "could not create diagnostic export directory: {cause}"
        ))
    })?;
    if !fallback.is_absolute() || !real_directory(&fallback) {
        return Err(Error::Report(
            "no safe absolute diagnostic export directory is available".into(),
        ));
    }
    Ok(fallback)
}

fn real_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn headless_archive_name(taken: &str) -> String {
    let timestamp = taken
        .trim_end_matches('Z')
        .chars()
        .map(|character| match character {
            ':' | '/' | '\\' => '-',
            'T' => '_',
            character => character,
        })
        .collect::<String>();
    format!("dsh-studio-diagnostics-{timestamp}.zip")
}

fn headless_report(version: &str, taken: &str, logs: usize, crashes: usize) -> String {
    redact(&format!(
        "# dsh-studio headless diagnostics\n\n\
         Taken {taken}. This package was exported before Tauri, a window, or Harness started.\n\n\
         ## Build\n\n\
         version: {version}\n\
         platform: {}-{}\n\n\
         ## Locations\n\n\
         application data: {}\n\
         DSH home: {}\n\n\
         ## Evidence\n\n\
         persistent logs: {logs}\n\
         crash files: {crashes}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        crate::paths::app_data_dir().display(),
        crate::paths::dsh_home().display(),
    ))
}

fn write_archive(path: &Path, report: &str, logs: &[PathBuf], crashes: &[PathBuf]) -> Result<()> {
    if !path.is_absolute() {
        return Err(Error::Report(
            "the diagnostic archive needs an absolute destination".into(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| Error::Report("the diagnostic archive has no parent directory".into()))?;
    let parent_kind = std::fs::symlink_metadata(parent)
        .map_err(|cause| Error::Report(format!("could not inspect archive destination: {cause}")))?
        .file_type();
    if parent_kind.is_symlink() || !parent_kind.is_dir() {
        return Err(Error::Report(
            "the diagnostic archive destination is not a real directory".into(),
        ));
    }
    if std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
        .unwrap_or(false)
    {
        return Err(Error::Report(
            "the diagnostic archive destination is not a regular file".into(),
        ));
    }

    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("dsh-studio-diagnostics.zip"),
        std::process::id()
    ));
    let result = build_archive(&temporary, report, logs, crashes);
    if let Err(cause) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(cause);
    }
    if path.exists() {
        std::fs::remove_file(path).map_err(|cause| {
            Error::Report(format!("could not replace diagnostic archive: {cause}"))
        })?;
    }
    std::fs::rename(&temporary, path)
        .map_err(|cause| Error::Report(format!("could not publish diagnostic archive: {cause}")))
}

fn build_archive(path: &Path, report: &str, logs: &[PathBuf], crashes: &[PathBuf]) -> Result<()> {
    let file = std::fs::File::create(path)
        .map_err(|cause| Error::Report(format!("could not create diagnostic archive: {cause}")))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    let report = redact(report);
    let mut used = report.len() as u64;
    zip.start_file("report.md", options)
        .and_then(|_| {
            zip.write_all(report.as_bytes())
                .map_err(zip::result::ZipError::Io)
        })
        .map_err(|cause| Error::Report(format!("could not write diagnostic report: {cause}")))?;

    let mut omitted = Vec::new();
    let mut count = 1;
    for (kind, paths) in [("logs", logs), ("crash-evidence", crashes)] {
        for source in paths {
            if count == ARCHIVE_MAX_FILES {
                omitted.push(format!("{}: file-count limit", source.display()));
                continue;
            }
            let metadata = match std::fs::symlink_metadata(source) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    metadata
                }
                _ => {
                    omitted.push(format!("{}: unsafe or unavailable", source.display()));
                    continue;
                }
            };
            if metadata.len() > ARCHIVE_ENTRY_CEILING
                || used.saturating_add(metadata.len()) > ARCHIVE_CEILING
            {
                omitted.push(format!("{}: evidence-size limit", source.display()));
                continue;
            }
            let name = source
                .file_name()
                .and_then(|name| name.to_str())
                .map(safe_leaf)
                .unwrap_or_else(|| format!("evidence-{count}"));
            let entry = format!("{kind}/{count:02}-{name}");
            let bytes = read_evidence(source, metadata.len())?;
            let bytes = if textual(source) {
                redact(&String::from_utf8_lossy(&bytes)).into_bytes()
            } else {
                bytes
            };
            used = used.saturating_add(bytes.len() as u64);
            zip.start_file(entry, options)
                .and_then(|_| zip.write_all(&bytes).map_err(zip::result::ZipError::Io))
                .map_err(|cause| {
                    Error::Report(format!("could not add diagnostic evidence: {cause}"))
                })?;
            count += 1;
        }
    }

    if !omitted.is_empty() {
        let note = redact(&format!(
            "Some evidence was omitted to keep the archive bounded:\n{}\n",
            omitted.join("\n")
        ));
        zip.start_file("omitted.txt", options)
            .and_then(|_| {
                zip.write_all(note.as_bytes())
                    .map_err(zip::result::ZipError::Io)
            })
            .map_err(|cause| Error::Report(format!("could not add omission notice: {cause}")))?;
    }
    zip.finish()
        .map(|_| ())
        .map_err(|cause| Error::Report(format!("could not finish diagnostic archive: {cause}")))
}

fn read_evidence(path: &Path, expected: u64) -> Result<Vec<u8>> {
    let file = std::fs::File::open(path)
        .map_err(|cause| Error::Report(format!("could not read {}: {cause}", path.display())))?;
    let mut bytes = Vec::with_capacity(expected.min(ARCHIVE_ENTRY_CEILING) as usize);
    file.take(ARCHIVE_ENTRY_CEILING + 1)
        .read_to_end(&mut bytes)
        .map_err(|cause| Error::Report(format!("could not read {}: {cause}", path.display())))?;
    if bytes.len() as u64 > ARCHIVE_ENTRY_CEILING {
        return Err(Error::Report(
            "diagnostic evidence changed while it was read".into(),
        ));
    }
    Ok(bytes)
}

fn textual(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("txt" | "log" | "crash" | "ips" | "json")
    )
}

fn safe_leaf(name: &str) -> String {
    let mut leaf: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '\0' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .take(120)
        .collect();
    if leaf.is_empty() || leaf == "." || leaf == ".." {
        leaf = "evidence".into();
    }
    leaf
}

/// Everything the shell knows about itself, as one document.
fn compose(version: &str, supervisor: &Supervisor, remote_open: bool) -> Report {
    let taken = stamp(now_millis());
    let environment = crate::harness::environment();
    let profile = crate::plugins::state();

    let mut out = String::with_capacity(16 << 10);
    let _ = writeln!(out, "# dsh-studio diagnostics\n");
    let _ = writeln!(
        out,
        "Taken {taken}. The home directory is written as `{MASK}`, and nothing \
         about remote pairing is in here.\n"
    );

    section(&mut out, "Build", &build_block(version));
    section(&mut out, "Node.js", &node_block(&environment));
    section(
        &mut out,
        "Harness",
        &harness_block(&environment, supervisor, remote_open),
    );
    section(&mut out, "Profile", &profile_block(&profile));
    section(&mut out, "Evidence", &evidence_block(supervisor));
    log_section(&mut out, supervisor);

    Report {
        name: file_name(&taken),
        archive_name: archive_name(&taken),
        text: redact(&out),
    }
}

fn build_block(version: &str) -> String {
    rows(&[
        ("version", version.to_string()),
        (
            "platform",
            format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        ),
    ])
}

/// Every runtime found, not only the chosen one.
///
/// Which one was picked is a fact about the machine, and so is every one that
/// was passed over: half of "the harness will not start" is a version manager
/// putting something too old in front of something new enough.
fn node_block(environment: &Environment) -> String {
    let mut block = rows(&[
        ("minimum", format!("v{}", environment.minimum_node)),
        (
            "chosen",
            match &environment.node {
                Some(node) => format!("v{}", node.version),
                None => "nothing on this machine qualifies".to_string(),
            },
        ),
        (
            "found",
            plural(environment.all_node_runtimes.len(), "runtime"),
        ),
    ]);

    for install in &environment.all_node_runtimes {
        let version = format!("v{}", install.version);
        // The variant name is the label here. It is one word, it is the word the
        // panel shows, and a match arm repeating all six of them would be a
        // second list to keep in step with the first.
        let source = format!("{:?}", install.source).to_ascii_lowercase();
        let _ = write!(
            block,
            "\n  {version:<11} {source:<8} {}",
            install.path.display()
        );
    }
    block
}

fn harness_block(environment: &Environment, supervisor: &Supervisor, remote_open: bool) -> String {
    rows(&[
        (
            "installed",
            yes_no(environment.harness_installed).to_string(),
        ),
        ("entry", environment.harness_entry.display().to_string()),
        ("workspace", environment.workspace.display().to_string()),
        ("state", phase(&supervisor.status())),
        (
            "remote",
            if remote_open { "open" } else { "closed" }.to_string(),
        ),
    ])
}

fn profile_block(state: &PluginState) -> String {
    let mut block = rows(&[
        ("name", state.profile.clone()),
        ("directory", state.profile_dir.display().to_string()),
        ("initialized", yes_no(state.initialized).to_string()),
        (
            "pnpm",
            if state.package_manager {
                "found"
            } else {
                "not found"
            }
            .to_string(),
        ),
        ("plugins", plural(state.plugins.len(), "plugin")),
    ]);

    for plugin in &state.plugins {
        let standing = standing(plugin);
        let _ = write!(block, "\n  {standing:<8}  {}", plugin.name);
        if !plugin.spec.is_empty() {
            let _ = write!(block, "  {}", plugin.spec);
        }
    }
    block
}

fn evidence_block(supervisor: &Supervisor) -> String {
    let persistent = supervisor
        .persistent_log_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "persistent logging unavailable".to_string());
    let crashes = crate::logging::crash_files();
    rows(&[
        ("persistent log", persistent),
        ("crash files", plural(crashes.len(), "file")),
        (
            "plugin recovery",
            crate::plugins::recovery::notice()
                .map(|notice| notice.detail)
                .unwrap_or_else(|| "none pending".to_string()),
        ),
    ])
}

/// The tail of the harness log, which is usually the only part that matters.
fn log_section(out: &mut String, supervisor: &Supervisor) {
    let log = supervisor.recent_log();
    let _ = writeln!(out, "## Log\n");

    if log.is_empty() {
        let _ = writeln!(out, "Nothing has been logged since the shell started.");
        return;
    }

    let kept = tail(&log);
    // Said in prose rather than left to be inferred from the line count: a
    // truncated log that does not admit it is a log somebody will read as the
    // whole run and conclude the wrong thing from.
    if kept < log.len() {
        let _ = writeln!(
            out,
            "The last {kept} of {} lines the shell has kept.\n",
            log.len()
        );
    } else {
        let _ = writeln!(out, "All {} lines the shell has kept.\n", log.len());
    }

    let body = log[log.len() - kept..]
        .iter()
        .map(|(stream, line)| format!("{}  {line}", tag(*stream)))
        .collect::<Vec<_>>()
        .join("\n");

    let rail = fence(&body);
    let _ = writeln!(out, "{rail}\n{body}\n{rail}");
}

/// A titled block, fenced so a paste into an issue keeps its alignment.
fn section(out: &mut String, title: &str, body: &str) {
    let rail = fence(body);
    let _ = writeln!(out, "## {title}\n\n{rail}\n{body}\n{rail}\n");
}

/// A fence longer than any the body opens on a line of its own.
///
/// Harness output is arbitrary text, and a line of it that happens to start a
/// code fence would close this one early — putting the rest of the report back
/// into the prose, where a renderer is free to reflow it into one paragraph.
fn fence(body: &str) -> String {
    let longest = body
        .lines()
        .map(|line| {
            line.trim_start()
                .chars()
                .take_while(|mark| *mark == '`')
                .count()
        })
        .max()
        .unwrap_or(0);

    "`".repeat(longest.max(2) + 1)
}

/// How many of the newest lines the report can carry.
///
/// At least one, however long it is: a log section that is empty because a
/// single line overran the ceiling says less than one holding only the line that
/// mattered.
fn tail(log: &[(Stream, String)]) -> usize {
    let mut kept = 0;
    let mut bytes = 0;

    for (_, line) in log.iter().rev() {
        // The stream tag, the two spaces after it, and the newline.
        let cost = line.len() + 6;
        if kept > 0 && (kept == LOG_LINES || bytes + cost > LOG_CEILING) {
            break;
        }
        bytes += cost;
        kept += 1;
    }
    kept
}

/// Label-and-value lines, with every value starting in the same column.
fn rows(entries: &[(&str, String)]) -> String {
    let width = entries
        .iter()
        .map(|(label, _)| label.len())
        .max()
        .unwrap_or(0);

    entries
        .iter()
        .map(|(label, value)| format!("{label:width$}  {value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// What the profile is doing with one package.
///
/// Four answers rather than two flags, because the difference between them is
/// the difference between the bugs they cause: a plugin that was switched off
/// can be switched back on, and one that never declared a patch never will be.
fn standing(plugin: &InstalledPlugin) -> &'static str {
    if plugin.builtin {
        "built-in"
    } else if plugin.disabled {
        "disabled"
    } else if plugin.active {
        "active"
    } else {
        "library"
    }
}

fn phase(status: &Status) -> String {
    match status {
        Status::Stopped => "stopped".to_string(),
        Status::Starting => "starting".to_string(),
        Status::Ready { origin, pid } => format!("ready on {origin}, pid {pid}"),
        Status::Restarting { attempt, delay_ms } => {
            format!("restarting, attempt {attempt} after {delay_ms} ms")
        }
        Status::Failed { reason } => format!("failed: {reason}"),
    }
}

fn tag(stream: Stream) -> &'static str {
    match stream {
        Stream::Stdout => "out",
        Stream::Stderr => "err",
    }
}

fn yes_no(flag: bool) -> &'static str {
    if flag {
        "yes"
    } else {
        "no"
    }
}

fn plural(count: usize, thing: &str) -> String {
    if count == 1 {
        format!("1 {thing}")
    } else {
        format!("{count} {thing}s")
    }
}

/// What to call the file, dated so a support thread's attachments sort.
fn file_name(taken: &str) -> String {
    let day = taken.split('T').next().unwrap_or(taken);
    format!("dsh-studio-report-{day}.md")
}

fn archive_name(taken: &str) -> String {
    let day = taken.split('T').next().unwrap_or(taken);
    format!("dsh-studio-diagnostics-{day}.zip")
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or_default()
}

/// Take the user's home directory out of the finished report.
fn redact(text: &str) -> String {
    let paths = match dirs::home_dir() {
        Some(home) => scrub(text, &home.display().to_string()),
        None => text.to_string(),
    };
    crate::logging::redact_secrets(&paths)
}

/// The substitution itself, with the directory passed in so it can be tested.
///
/// A report is written to be pasted somewhere public, and the home directory is
/// the one thing in it that names a person: `C:\Users\...` carries an account
/// name into an issue that outlives the bug being reported.
fn scrub(text: &str, home: &str) -> String {
    if home.is_empty() {
        return text.to_string();
    }

    let masked = hide(text, home, MASK);
    if cfg!(windows) {
        // The same directory as the tools write it. npm and pnpm print Windows
        // paths with forward slashes, and most of the log is their output.
        hide(&masked, &home.replace('\\', "/"), MASK)
    } else {
        masked
    }
}

/// Replace every occurrence, ignoring ASCII case.
///
/// Ignoring case because Windows does: the same directory arrives as `C:\Users`
/// from one tool and `c:\users` from the next, and a match that only caught one
/// of them would leak the other. ASCII only, deliberately — folding that way
/// cannot change the length of a byte sequence, so the positions found in the
/// folded copy are positions in the original, which is what lets a name outside
/// ASCII be matched exactly instead of being cut in half.
fn hide(text: &str, needle: &str, mask: &str) -> String {
    let haystack = text.to_ascii_lowercase();
    let pin = needle.to_ascii_lowercase();

    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(offset) = haystack[at..].find(&pin) {
        let start = at + offset;
        out.push_str(&text[at..start]);
        out.push_str(mask);
        at = start + pin.len();
    }
    out.push_str(&text[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_home_directory_leaves_the_report_as_a_tilde() {
        let text = scrub(
            "entry  C:\\Users\\ada\\AppData\\Local\\dsh-studio\\harness",
            "C:\\Users\\ada",
        );

        assert_eq!(text, "entry  ~\\AppData\\Local\\dsh-studio\\harness");
    }

    #[test]
    fn the_case_a_tool_happened_to_write_it_in_does_not_save_it() {
        let text = scrub("cd c:\\users\\ada\\src", "C:\\Users\\ada");
        assert_eq!(text, "cd ~\\src");
    }

    #[cfg(windows)]
    #[test]
    fn the_slashes_npm_prints_are_taken_out_too() {
        let text = scrub("resolved C:/Users/ada/.dsh/profiles", "C:\\Users\\ada");
        assert_eq!(text, "resolved ~/.dsh/profiles");
    }

    #[test]
    fn every_mention_goes_not_only_the_first() {
        let text = scrub("/home/ada/a and /home/ada/b", "/home/ada");
        assert_eq!(text, "~/a and ~/b");
    }

    #[test]
    fn a_machine_with_no_home_directory_is_reported_unchanged() {
        assert_eq!(scrub("nothing to hide", ""), "nothing to hide");
    }

    #[test]
    fn exported_reports_remove_credentials_as_well_as_paths() {
        let text = redact("Authorization: Bearer top-secret api_key=sk-live");
        assert!(!text.contains("top-secret"));
        assert!(!text.contains("sk-live"));
        assert!(text.contains("[REDACTED]"));
    }

    #[test]
    fn a_name_outside_ascii_survives_being_matched() {
        let text = scrub("C:\\用户\\阿达\\项目", "C:\\用户\\阿达");
        assert_eq!(text, "~\\项目");
    }

    #[test]
    fn a_line_that_opens_a_fence_cannot_close_the_block() {
        // What a multi-line failure message looks like once it is in the log.
        let rail = fence("state  failed: npm said\n```\nand kept going");
        assert_eq!(rail, "````");
    }

    #[test]
    fn a_body_with_no_backticks_in_it_gets_the_ordinary_fence() {
        assert_eq!(fence("version  0.4.0"), "```");
    }

    #[test]
    fn a_section_is_a_heading_and_a_block_with_a_blank_line_after_it() {
        let mut out = String::new();
        section(&mut out, "Build", "version  0.4.0");

        assert_eq!(out, "## Build\n\n```\nversion  0.4.0\n```\n\n");
    }

    #[test]
    fn the_log_is_cut_to_the_newest_lines() {
        let log: Vec<_> = (0..LOG_LINES + 40)
            .map(|line| (Stream::Stdout, format!("line {line}")))
            .collect();

        assert_eq!(tail(&log), LOG_LINES);
    }

    #[test]
    fn a_short_log_is_carried_whole() {
        let log = vec![
            (Stream::Stdout, "starting".to_string()),
            (Stream::Stderr, "stopped".to_string()),
        ];

        assert_eq!(tail(&log), 2);
    }

    #[test]
    fn a_run_of_long_lines_stops_at_the_size_ceiling_instead() {
        // Sized so each line costs exactly a kilobyte once tagged, which puts
        // the size ceiling a long way in front of the line count.
        let log: Vec<_> = (0..LOG_LINES)
            .map(|_| (Stream::Stdout, "x".repeat(1_018)))
            .collect();

        assert_eq!(tail(&log), LOG_CEILING / 1_024);
    }

    #[test]
    fn one_line_longer_than_the_whole_ceiling_is_still_reported() {
        let log = vec![(Stream::Stderr, "x".repeat(LOG_CEILING * 2))];
        assert_eq!(tail(&log), 1);
    }

    #[test]
    fn the_file_is_named_after_the_day_it_was_taken() {
        assert_eq!(
            file_name("2026-08-18T09:14:33Z"),
            "dsh-studio-report-2026-08-18.md"
        );
        assert_eq!(
            archive_name("2026-08-18T09:14:33Z"),
            "dsh-studio-diagnostics-2026-08-18.zip"
        );
    }

    #[test]
    fn diagnostic_archives_redact_text_and_preserve_binary_evidence() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-diagnostic-archive-{}-{}",
            std::process::id(),
            now_millis()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let log = root.join("runtime.log");
        let dump = root.join("native.dmp");
        let out = root.join("support.zip");
        std::fs::write(&log, "Authorization: Bearer secret-value").unwrap();
        std::fs::write(&dump, [0_u8, 1, 2, 3]).unwrap();

        write_archive(&out, "api_key=sk-report", &[log], &[dump]).unwrap();
        let file = std::fs::File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut report = String::new();
        zip.by_name("report.md")
            .unwrap()
            .read_to_string(&mut report)
            .unwrap();
        assert!(!report.contains("sk-report"));
        let mut log = String::new();
        zip.by_name("logs/01-runtime.log")
            .unwrap()
            .read_to_string(&mut log)
            .unwrap();
        assert!(!log.contains("secret-value"));
        let mut dump = Vec::new();
        zip.by_name("crash-evidence/02-native.dmp")
            .unwrap()
            .read_to_end(&mut dump)
            .unwrap();
        assert_eq!(dump, [0_u8, 1, 2, 3]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn headless_report_is_redacted_and_states_that_runtime_was_not_started() {
        let report = headless_report("0.7.1", "2026-08-22T07:30:00Z", 2, 1);
        assert!(report.contains("before Tauri, a window, or Harness started"));
        assert!(report.contains("version: 0.7.1"));
        assert!(report.contains("persistent logs: 2"));
        if let Some(home) = dirs::home_dir() {
            assert!(!report.contains(&home.display().to_string()));
        }
    }

    #[test]
    fn headless_archive_names_are_unique_safe_timestamped_leaves() {
        let name = headless_archive_name("2026-08-22T07:30:15.123Z");
        assert_eq!(name, "dsh-studio-diagnostics-2026-08-22_07-30-15.123.zip");
        assert!(!name.contains(['/', '\\', ':']));
    }

    #[test]
    fn archive_leaf_names_cannot_create_paths() {
        assert_eq!(safe_leaf("../secret\\dump.dmp"), ".._secret_dump.dmp");
        assert_eq!(safe_leaf(""), "evidence");
    }

    #[test]
    fn values_start_in_one_column_however_long_the_labels_are() {
        let block = rows(&[
            ("name", "default".to_string()),
            ("initialized", "yes".to_string()),
        ]);

        assert_eq!(block, "name         default\ninitialized  yes");
    }

    #[test]
    fn a_plugin_switched_off_reads_as_something_that_can_come_back() {
        let entry = |active, disabled, builtin| InstalledPlugin {
            name: "@vendor/dsh-notes".into(),
            spec: "^1.0.0".into(),
            active,
            disabled,
            builtin,
            market_receipt: None,
        };

        assert_eq!(standing(&entry(false, true, false)), "disabled");
        assert_eq!(standing(&entry(false, false, false)), "library");
        assert_eq!(standing(&entry(true, false, false)), "active");
        assert_eq!(standing(&entry(true, false, true)), "built-in");
    }
}

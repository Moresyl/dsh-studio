//! The plugin marketplace: what is installed, and changing it.
//!
//! Plugins are ordinary npm packages that declare a profile patch, and the
//! harness already knows how to add and remove them — `dsh plugin` installs
//! into the profile directory and then reconciles the layer list against what
//! is actually on disk. Reimplementing that reconciliation here would mean
//! owning a copy of someone else's rule, so this module does not: it reads the
//! profile manifest to say what is installed, and it drives the harness's own
//! command to change it.
//!
//! What the shell does add is the part a desktop user cannot reasonably be
//! asked to do themselves. `dsh plugin` forwards to pnpm and gives up if pnpm
//! is not on PATH; a person who installed a desktop app has not agreed to go
//! and install a package manager first. So the shell keeps one under its own
//! data directory and puts it on the PATH of that one child process — not on
//! the user's, and not on any other program's.

pub mod commands;
pub mod registry;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use proc_guard::ProcessGuard;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::{Error, Result};
use crate::harness::install;
use crate::harness::supervisor::Stream;
use crate::paths;

/// The profile `dsh web` boots, and therefore the only one a plugin installed
/// from this panel would affect.
pub const PROFILE: &str = "web";

/// What the shell installs when the machine has no package manager of its own.
const PNPM_SPEC: &str = "pnpm@latest";

/// One entry in the profile's plugin list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub name: String,
    /// The range recorded in the profile manifest, empty for an in-box bundle.
    pub spec: String,
    /// In the layer stack: this package declares a profile patch, and the patch
    /// is applied. A dependency that is installed but inactive is a plain
    /// library, which is allowed and worth showing as different.
    pub active: bool,
    /// Part of the profile template rather than something installed here.
    /// Shown because it explains the harness's behaviour, never removable.
    pub builtin: bool,
}

/// Everything the plugin panel needs before it draws anything.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub profile: String,
    pub profile_dir: PathBuf,
    /// False until the harness has initialized the profile. The first install
    /// creates it, so this is a fact to display, not an error to report.
    pub initialized: bool,
    pub plugins: Vec<InstalledPlugin>,
    /// Whether a package manager is reachable. When false the first change
    /// installs one first, which is slow enough that the panel should say so.
    pub package_manager: bool,
}

/// Guard so two clicks cannot run two package managers over one directory.
#[derive(Debug, Default)]
pub struct PluginJobs {
    pub busy: AtomicBool,
}

/// What a change does to the profile.
#[derive(Clone, Copy, Debug)]
pub enum Change {
    Add,
    Remove,
}

impl Change {
    fn verb(self) -> &'static str {
        match self {
            // pnpm's own subcommands, because that is what `dsh plugin`
            // forwards its arguments to.
            Change::Add => "add",
            Change::Remove => "remove",
        }
    }
}

/// Read the profile as it is right now. Cheap; safe to call on every render.
pub fn state() -> PluginState {
    let profile_dir = paths::profile_dir(PROFILE);
    let manifest = read_manifest(&profile_dir);

    PluginState {
        profile: PROFILE.to_string(),
        initialized: manifest.is_some(),
        plugins: manifest.as_ref().map(list).unwrap_or_default(),
        package_manager: package_manager_available(),
        profile_dir,
    }
}

fn read_manifest(profile_dir: &Path) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(profile_dir.join("package.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Turn the manifest into the list the panel shows.
///
/// Two sources, deliberately merged: `dependencies` is what was installed, and
/// `dsh.profile.bundles` is what is switched on. A name in the second but not
/// the first came with the profile template.
fn list(manifest: &serde_json::Value) -> Vec<InstalledPlugin> {
    let bundles: Vec<&str> = manifest
        .pointer("/dsh/profile/bundles")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect()
        })
        .unwrap_or_default();

    let mut plugins: Vec<InstalledPlugin> = manifest
        .get("dependencies")
        .and_then(serde_json::Value::as_object)
        .map(|dependencies| {
            dependencies
                .iter()
                .map(|(name, spec)| InstalledPlugin {
                    active: bundles.contains(&name.as_str()),
                    name: name.clone(),
                    spec: spec.as_str().unwrap_or_default().to_string(),
                    builtin: false,
                })
                .collect()
        })
        .unwrap_or_default();

    for name in bundles {
        if !plugins.iter().any(|plugin| plugin.name == name) {
            plugins.push(InstalledPlugin {
                name: name.to_string(),
                spec: String::new(),
                active: true,
                builtin: true,
            });
        }
    }

    // Installed plugins first — they are what the user acted on — then the
    // in-box bundles, each group alphabetical so the list does not reshuffle.
    plugins.sort_by(|left, right| {
        left.builtin
            .cmp(&right.builtin)
            .then_with(|| left.name.cmp(&right.name))
    });
    plugins
}

/// Add or remove one plugin, reporting every line the tools produce.
///
/// The package manager is bootstrapped first if this machine has none, because
/// the alternative is a 127 exit code and a message telling a desktop user to
/// go and install pnpm.
pub async fn change<R>(change: Change, spec: &str, guard: &ProcessGuard, report: R) -> Result<()>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    if !is_package_spec(spec) {
        return Err(Error::Plugin(format!(
            "{spec} is not a package name this panel will pass on"
        )));
    }

    let environment = crate::harness::environment();
    let node = environment.node.ok_or(Error::NoNodeRuntime {
        minimum: node_runtime::MINIMUM_SUPPORTED,
    })?;
    if !environment.harness_installed {
        return Err(Error::HarnessNotInstalled);
    }
    let manager = ensure_package_manager(&node.path, guard, report.clone()).await?;

    let mut command = Command::new(&node.path);
    command
        .arg(&environment.harness_entry)
        .arg("plugin")
        .arg("--profile")
        .arg(PROFILE)
        .arg(change.verb())
        .arg(spec)
        // Relative specs would be anchored against this directory. Only package
        // names get this far, so it exists to be somewhere predictable rather
        // than wherever the app happened to be launched from.
        .current_dir(paths::app_data_dir())
        .env("PATH", path_with(&node.path, manager.as_deref()))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: pnpm is a console program, and a black rectangle
        // appearing over the app is not progress reporting.
        command.creation_flags(0x0800_0000);
    }

    let mut child = guard.spawn(&mut command).map_err(Error::Spawn)?;
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let out = tokio::spawn(forward(stdout, Stream::Stdout, report.clone()));
    let err = tokio::spawn(forward(stderr, Stream::Stderr, report));

    let status = child.wait().await.map_err(|cause| {
        Error::Plugin(format!(
            "the plugin command could not be waited on: {cause}"
        ))
    })?;
    let _ = tokio::join!(out, err);

    if !status.success() {
        return Err(Error::Plugin(format!(
            "the plugin command exited with {status}"
        )));
    }
    Ok(())
}

async fn forward<P, R>(pipe: P, stream: Stream, report: R)
where
    P: tokio::io::AsyncRead + Unpin,
    R: Fn(Stream, String),
{
    let mut lines = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        report(stream, line);
    }
}

/// Whether the harness will find a package manager when it looks for one.
pub fn package_manager_available() -> bool {
    managed_manager().is_some() || on_path("pnpm").is_some()
}

/// Make sure there is a pnpm to forward to, installing one if there is not.
///
/// Returns the directory to prepend to the child's PATH, or `None` when the
/// machine already had pnpm and nothing needs prepending.
async fn ensure_package_manager<R>(
    node: &Path,
    guard: &ProcessGuard,
    report: R,
) -> Result<Option<PathBuf>>
where
    R: Fn(Stream, String) + Clone + Send + 'static,
{
    if let Some(directory) = managed_manager() {
        return Ok(Some(directory));
    }
    if on_path("pnpm").is_some() {
        return Ok(None);
    }

    report(
        Stream::Stdout,
        "no package manager found; installing one for the plugin system".to_string(),
    );
    let plan = install::plan(node, paths::tools_dir(), PNPM_SPEC.to_string())?;
    install::run(&plan, guard, report).await?;

    managed_manager().map(Some).ok_or_else(|| {
        Error::Plugin("the package manager installed but left no executable behind".into())
    })
}

/// The `.bin` directory of the pnpm the shell installed, if it is there.
///
/// npm writes the platform's own launcher into `.bin` — a `.cmd` on Windows, a
/// symlink elsewhere — which is exactly what the harness's PATH lookup expects
/// to find, so nothing here has to write a shim of its own.
fn managed_manager() -> Option<PathBuf> {
    let directory = paths::tools_dir().join("node_modules").join(".bin");
    executable_in(&directory, "pnpm").map(|_| directory)
}

fn on_path(stem: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|directory| executable_in(&directory, stem))
}

fn executable_in(directory: &Path, stem: &str) -> Option<PathBuf> {
    // Windows resolves a bare name through PATHEXT, so the launcher may carry
    // any of these; everywhere else the name is the whole story.
    #[cfg(windows)]
    let candidates = [
        format!("{stem}.cmd"),
        format!("{stem}.exe"),
        format!("{stem}.bat"),
        stem.to_string(),
    ];
    #[cfg(not(windows))]
    let candidates = [stem.to_string()];

    candidates
        .into_iter()
        .map(|name| directory.join(name))
        .find(|candidate| candidate.is_file())
}

/// `PATH` for the child: the chosen Node first, then any managed pnpm, then
/// whatever the user has. Nothing is written to the user's own environment.
fn path_with(node: &Path, manager: Option<&Path>) -> OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut entries: Vec<PathBuf> = Vec::new();

    if let Some(directory) = node.parent() {
        entries.push(directory.to_path_buf());
    }
    if let Some(directory) = manager {
        entries.push(directory.to_path_buf());
    }
    entries.extend(std::env::split_paths(&existing));
    std::env::join_paths(entries).unwrap_or(existing)
}

/// Whether a string is a package name, optionally with a version.
///
/// Everything here is spawned without a shell, so this is not about quoting. It
/// is about the one thing that would otherwise slip through: an argument
/// beginning with `-` is a flag to the package manager, not a package, and a
/// relative path spec would be resolved somewhere the user did not mean.
fn is_package_spec(spec: &str) -> bool {
    if spec.is_empty() || spec.len() > 214 {
        return false;
    }
    if spec.starts_with('-') || spec.chars().any(char::is_whitespace) {
        return false;
    }

    let (name, version) = split_spec(spec);
    if version.is_some_and(|range| range.is_empty() || range.contains(':')) {
        return false;
    }
    is_package_name(name)
}

/// Split `@scope/name@^1.2.3` at the separator that is not the scope marker.
fn split_spec(spec: &str) -> (&str, Option<&str>) {
    let scoped = usize::from(spec.starts_with('@'));
    match spec[scoped..].find('@') {
        Some(at) => (&spec[..scoped + at], Some(&spec[scoped + at + 1..])),
        None => (spec, None),
    }
}

fn is_package_name(name: &str) -> bool {
    match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((scope, rest)) => is_name_segment(scope) && is_name_segment(rest),
            None => false,
        },
        None => is_name_segment(name),
    }
}

fn is_name_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 128
        && !segment.starts_with(['.', '_'])
        && segment.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '.' | '_')
        })
}

#[cfg(test)]
mod tests {
    use super::{is_package_spec, list, split_spec};

    fn manifest(raw: &str) -> serde_json::Value {
        serde_json::from_str(raw).expect("test manifest")
    }

    #[test]
    fn separates_installed_plugins_from_the_ones_that_came_with_the_profile() {
        let plugins = list(&manifest(
            r#"{
                "dependencies": { "@vendor/dsh-notes": "^1.2.0" },
                "dsh": { "profile": { "bundles": [
                    "@deepseek-ai/dsh-base",
                    "@vendor/dsh-notes"
                ] } }
            }"#,
        ));

        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].name, "@vendor/dsh-notes");
        assert!(plugins[0].active && !plugins[0].builtin);
        assert_eq!(plugins[0].spec, "^1.2.0");
        assert!(plugins[1].builtin, "in-box bundles are not removable");
    }

    #[test]
    fn shows_an_installed_dependency_that_is_not_a_layer() {
        // A plain library the harness declined to activate still has to appear,
        // or the panel would offer no way to remove it.
        let plugins = list(&manifest(
            r#"{ "dependencies": { "left-pad": "^1.3.0" }, "dsh": { "profile": { "bundles": [] } } }"#,
        ));

        assert_eq!(plugins.len(), 1);
        assert!(!plugins[0].active);
        assert!(!plugins[0].builtin);
    }

    #[test]
    fn reads_an_empty_profile_without_complaining() {
        assert!(list(&manifest(r#"{ "name": "dsh-profile-web" }"#)).is_empty());
    }

    #[test]
    fn accepts_the_specs_a_marketplace_produces() {
        assert!(is_package_spec("left-pad"));
        assert!(is_package_spec("@vendor/dsh-notes"));
        assert!(is_package_spec("@vendor/dsh-notes@1.2.3"));
        assert!(is_package_spec("@vendor/dsh-notes@^1.2.0"));
        assert!(is_package_spec("dsh.bundle_thing-2"));
    }

    #[test]
    fn rejects_anything_that_is_not_one() {
        assert!(!is_package_spec(""), "empty");
        assert!(!is_package_spec("--force"), "a flag is not a package");
        assert!(!is_package_spec("-D"), "a short flag is not a package");
        assert!(!is_package_spec("../plugin"), "a relative path");
        assert!(!is_package_spec("file:../plugin"), "a path spec");
        assert!(!is_package_spec("git+https://host/x.git"), "a git spec");
        assert!(!is_package_spec("two words"), "whitespace");
        assert!(!is_package_spec("@scope"), "a scope without a name");
        assert!(!is_package_spec("UPPER"), "npm names are lowercase");
        assert!(!is_package_spec(".hidden"), "cannot start with a dot");
    }

    #[test]
    fn splits_a_scoped_spec_at_the_right_at_sign() {
        assert_eq!(
            split_spec("@vendor/name@1.0.0"),
            ("@vendor/name", Some("1.0.0"))
        );
        assert_eq!(split_spec("@vendor/name"), ("@vendor/name", None));
        assert_eq!(split_spec("name@1.0.0"), ("name", Some("1.0.0")));
        assert_eq!(split_spec("name"), ("name", None));
    }
}

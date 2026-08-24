//! The harnesses one installation can hold, and which of them this window hosts.
//!
//! A profile is a directory under `$DSH_HOME/profiles` with a manifest in it:
//! the layer list the harness composes at boot, and the plugins it was composed
//! from. The harness ships a template for the names it knows — `web` is the one
//! with an interface in it — writes the directory on first use, and otherwise
//! takes the directory name as the profile's whole identity. So the shell needs
//! no model of what a profile *is*. It needs to be able to make one, copy one,
//! name one, take one away, and say how two of them differ.
//!
//! Making one is the part with a subtlety worth writing down. The harness's own
//! initializer gives a name it has no template for the default bundle list,
//! which is the base layer and nothing else: a profile that boots and serves no
//! interface, so a window pointed at it would sit waiting for a page that is
//! never coming. A new profile is therefore written here, from the bundles the
//! shipped web profile is carrying on this machine — not from a copy of the
//! harness's template kept in this repository, which would be a second copy of
//! someone else's constant and would go stale the first time they changed it.
//!
//! Everything that installs goes back out through `dsh plugin`, the same command
//! the market uses. Nothing here resolves a package or writes a `dependencies`
//! entry: a manifest claiming something is installed that is not would boot into
//! the harness's own "cannot resolve bundle" error, and the shell has no business
//! producing that.

pub mod commands;
mod selection;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::paths;
use crate::plugins::{self, switches, InstalledPlugin};

/// The profile the harness ships an interface in, and the one this window hosts
/// until somebody chooses another.
pub const DEFAULT: &str = "web";

/// Names the harness ships a template for and re-creates by itself. Renaming or
/// deleting one of these would leave the user with a copy and a fresh original.
const SHIPPED: [&str; 2] = ["web", "headless"];

/// The one directory beside the profiles that is not a profile: the harness
/// links its whole dependency closure in here, which is how a profile with no
/// `node_modules` of its own still resolves the bundles that came with it.
const SHARED_MODULES: &str = "node_modules";

const MANIFEST: &str = "package.json";
const PATCH: &str = "cordis.patch.yml";
const WORKSPACE: &str = "pnpm-workspace.yaml";

/// An empty patch layer.
///
/// The harness writes the same empty array under three lines explaining what to
/// put in it. The array is the part its loader reads, and a new profile has
/// nothing to say in there yet.
const EMPTY_PATCH: &str = "[]\n";
const STUDIO_INTEGRATION: &str = "@moresyl/dsh-studio-integration";
const WEB_APP_BUNDLE: &str = "@deepseek-ai/dsh-web-app";
const WEB_PROFILE_BUNDLES: [&str; 2] = ["@deepseek-ai/dsh-base", WEB_APP_BUNDLE];
const PROFILE_WORKSPACE: &str =
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
const STUDIO_MODULE_FILES: [&str; 4] = [
    "package.json",
    "cordis.patch.yml",
    "lib/index.js",
    "lib/client.js",
];

/// What an exported profile is, so a file picked by mistake is caught before
/// anything is written.
const DECLARATION_KIND: &str = "dsh-studio-profile";

/// The declaration format. Version two adds a canonical SHA-256 integrity
/// envelope; version one remains readable as an explicitly unverified legacy
/// export.
const DECLARATION_VERSION: u32 = 2;
const LEGACY_DECLARATION_VERSION: u32 = 1;
const MAX_DECLARATION_BYTES: usize = 2 * 1024 * 1024;

/// One profile, as the switcher and the manager show it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: String,
    pub dir: PathBuf,
    /// Whether the harness has written a manifest for it yet. A directory
    /// without one is a profile waiting to be initialized, not a broken one.
    pub initialized: bool,
    /// A name the harness ships a template for, and will re-create if it goes.
    pub shipped: bool,
    /// Whether it carries the bundles the shipped web profile carries, which is
    /// what makes a profile one this window can show. Reported, never enforced:
    /// what boots is the harness's call, and the shell only has to make sure the
    /// answer is not a surprise.
    pub serves_window: bool,
    /// Plugins installed into it, the bundles it came with excluded.
    pub plugins: usize,
    /// How many of those the user has switched off.
    pub disabled: usize,
}

/// Every profile on the machine, and the one this window is pointed at.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Roster {
    pub profiles: Vec<Profile>,
    pub selected: String,
    /// Shown in the manager, because a profile is a directory and the first
    /// thing anyone wants when something is wrong with one is its path.
    pub root: PathBuf,
}

/// How one package stands in one profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Standing {
    /// Not in this profile at all.
    Absent,
    /// Installed, and in the layer stack.
    Active,
    /// Installed, and taken out of the layer stack by the user.
    Disabled,
    /// Installed and never in the layer stack — a plain library.
    Library,
    /// Came with the profile rather than being installed into it.
    Builtin,
}

/// One package, and what the two profiles say about it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    pub name: String,
    pub left: Standing,
    pub right: Standing,
    /// The range each side records, empty where there is none to record. Two
    /// profiles can both run a plugin and still not be running the same one.
    pub left_spec: String,
    pub right_spec: String,
    /// Whether the two sides agree about this package, in every respect above.
    pub same: bool,
}

/// Two profiles, side by side.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub left: String,
    pub right: String,
    pub rows: Vec<Difference>,
    /// Rows the two profiles disagree about, so the header can say how far apart
    /// they are without counting them again.
    pub differences: usize,
}

/// A profile as a file, for carrying one to another machine.
///
/// A declaration and not an archive. What a profile *has* is packages from a
/// registry and layers from the installation, and both of those are already on
/// the machine reading this file or can be fetched by it — so the file records
/// what was asked for, and the import asks for it again.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    pub kind: String,
    pub version: u32,
    /// The profile it came from, offered as the name to import it under.
    pub name: String,
    /// Plugins as name → range, exactly as the profile recorded them.
    pub plugins: BTreeMap<String, String>,
    /// Which of those were switched off.
    pub disabled: Vec<String>,
    /// The profile's own patch layer, verbatim. The one part of a profile that is
    /// nobody else's copy of anything.
    pub patch: String,
    /// SHA-256 of the canonical declaration fields. This detects damaged or
    /// accidentally edited backups; it is integrity evidence, not a publisher
    /// signature.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    /// Computed while reading, never trusted from or written into the file.
    #[serde(skip)]
    pub verified: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeclarationPayload<'a> {
    kind: &'a str,
    version: u32,
    name: &'a str,
    plugins: &'a BTreeMap<String, String>,
    disabled: &'a [String],
    patch: &'a str,
}

/// Every profile on the machine. Cheap; safe to call on every render.
pub fn roster() -> Roster {
    let template = template_bundles();

    Roster {
        profiles: scan()
            .into_iter()
            .map(|name| describe(&name, &template))
            .collect(),
        selected: selected(),
        root: paths::profiles_dir(),
    }
}

/// The profile this window hosts.
///
/// Falls back to the shipped web profile whenever the recorded name is not a
/// profile any more: a directory deleted from a terminal, or a selection file
/// written by hand. The fallback is silent on purpose — the alternative is an
/// application that will not start until someone fixes a JSON file.
pub fn selected() -> String {
    selection::chosen()
}

/// Point this window at another profile.
///
/// Only records the choice. What is already running keeps running, because the
/// layer stack is composed at boot and a restart is the only thing that can
/// change it — and a shell that killed a live session to apply a menu click
/// would be deciding something that is the user's to decide.
pub fn select(name: &str) -> Result<()> {
    let name = expect_profile(name)?;
    selection::choose(&name)
}

/// Prepare a profile for the runtime-owned Studio patch layer.
///
/// Older Studio releases persisted the integration package in the user's
/// bundle stack. That made a runtime concern part of user state and allowed the
/// same patch to be composed twice. The launcher now supplies the patch for
/// each process, so this migration removes only that managed entry. User
/// bundles, dependencies and their order stay untouched.
pub fn prepare_for_studio(name: &str) -> Result<bool> {
    let dir = paths::profile_dir(name);
    let serves_studio = prepare_for_studio_in(&dir, name == DEFAULT)?;
    if serves_studio {
        sync_studio_runtime_module()?;
    }
    Ok(serves_studio)
}

fn prepare_for_studio_in(dir: &Path, bootstrap_web: bool) -> Result<bool> {
    if !dir.join(MANIFEST).is_file() {
        if !bootstrap_web {
            return Ok(false);
        }
        let bundles = WEB_PROFILE_BUNDLES.map(str::to_string);
        initialize(dir, &bundles, EMPTY_PATCH, Some(PROFILE_WORKSPACE))?;
        return Ok(true);
    }

    let Some(mut manifest) = plugins::read_manifest(dir) else {
        return Err(Error::Profile(format!(
            "{} has an invalid profile manifest",
            dir.display()
        )));
    };
    let Some(bundles) = manifest
        .pointer_mut("/dsh/profile/bundles")
        .and_then(Value::as_array_mut)
    else {
        return Err(Error::Profile(format!(
            "{} has no profile bundle list",
            dir.display()
        )));
    };
    let serves_studio = bundles.iter().any(|bundle| bundle == WEB_APP_BUNDLE);
    let before = bundles.len();
    bundles.retain(|bundle| bundle.as_str() != Some(STUDIO_INTEGRATION));
    if bundles.len() != before {
        write_manifest(dir, &manifest)?;
    }
    Ok(serves_studio)
}

/// Make the runtime-owned package resolvable through Node's ordinary parent
/// lookup from every profile. Upstream maintains the same shared
/// `$DSH_HOME/profiles/node_modules` fallback for its own dependency closure;
/// Studio adds only its private package, which is outside that closure.
fn sync_studio_runtime_module() -> Result<()> {
    let source = paths::harness_dir()
        .join("node_modules")
        .join("@moresyl")
        .join("dsh-studio-integration");
    let target = paths::profiles_dir()
        .join(SHARED_MODULES)
        .join("@moresyl")
        .join("dsh-studio-integration");
    sync_runtime_module_in(&source, &target)
}

fn sync_runtime_module_in(source: &Path, target: &Path) -> Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(target) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(Error::Profile(format!(
                "{} is not a safe Studio module directory",
                target.display()
            )));
        }
    }

    for relative in STUDIO_MODULE_FILES {
        let source_file = source.join(relative);
        let source_metadata = std::fs::symlink_metadata(&source_file).map_err(|cause| {
            Error::Profile(format!(
                "the managed Studio module is incomplete at {}: {cause}",
                source_file.display()
            ))
        })?;
        if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
            return Err(Error::Profile(format!(
                "the managed Studio module has an unsafe file at {}",
                source_file.display()
            )));
        }

        let target_file = target.join(relative);
        if let Ok(metadata) = std::fs::symlink_metadata(&target_file) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(Error::Profile(format!(
                    "{} is not a safe Studio module file",
                    target_file.display()
                )));
            }
        }
        let parent = target_file.parent().expect("a module file has a parent");
        std::fs::create_dir_all(parent).map_err(|cause| {
            Error::Profile(format!(
                "{} could not be created: {cause}",
                parent.display()
            ))
        })?;
        let body = std::fs::read(&source_file).map_err(|cause| {
            Error::Profile(format!(
                "{} could not be read: {cause}",
                source_file.display()
            ))
        })?;
        std::fs::write(&target_file, body).map_err(|cause| {
            Error::Profile(format!(
                "{} could not be written: {cause}",
                target_file.display()
            ))
        })?;
    }
    Ok(())
}

/// Make a profile with the interface bundles in it and nothing else.
pub fn create(name: &str) -> Result<()> {
    let bundles = interface_bundles()?;
    build(name, |dir| {
        initialize(dir, &bundles, EMPTY_PATCH, workspace(DEFAULT).as_deref())
    })
}

/// Copy a profile, and say what the copy still has to install to be one.
///
/// The specs come back rather than being installed here so that the process
/// work — finding a package manager, streaming its output, guarding against a
/// second one — stays in the module that already does it for the market.
pub fn duplicate(source: &str, name: &str) -> Result<Vec<String>> {
    let source = expect_profile(source)?;
    let Some(manifest) = plugins::read_manifest(&paths::profile_dir(&source)) else {
        return Err(Error::Profile(format!(
            "{source} has not been initialized yet, so there is nothing to copy"
        )));
    };

    let installed = dependencies(&manifest);
    let mut specs = Vec::with_capacity(installed.len());
    for (package, range) in &installed {
        let spec = format!("{package}@{range}");
        // A path dependency is anchored against the directory the install ran
        // in, so re-asking for it from anywhere else would fetch something else
        // or nothing. Refusing to copy it is the honest answer; pretending the
        // copy is faithful is not.
        if !plugins::is_package_spec(&spec) {
            return Err(Error::Profile(format!(
                "{source} installs {package} from {range}, which a copy cannot ask for again"
            )));
        }
        specs.push(spec);
    }

    // Only the bundles that came with the source. Everything it installed is in
    // `specs`, and the harness puts each one back into the layer list itself as
    // it installs it — listing them here first would mean a manifest naming
    // layers that are not on disk yet.
    let carried: Vec<String> = bundles(&manifest)
        .into_iter()
        .filter(|bundle| !installed.contains_key(bundle))
        .collect();

    build(name, |dir| {
        initialize(
            dir,
            &carried,
            &patch(&source).unwrap_or_else(|| EMPTY_PATCH.to_string()),
            workspace(&source).as_deref(),
        )?;
        switches::copy(&source, name)
    })?;
    Ok(specs)
}

/// Give a profile another name, keeping everything in it.
pub fn rename(from: &str, to: &str) -> Result<()> {
    let from = expect_profile(from)?;
    if SHIPPED.contains(&from.as_str()) {
        return Err(Error::Profile(format!(
            "{from} is one of the harness's own profiles; renaming it would only leave the harness to write a new one"
        )));
    }

    let target = free_dir(to)?;
    std::fs::rename(paths::profile_dir(&from), &target).map_err(|cause| {
        Error::Profile(format!(
            "{from} could not be renamed: {cause}. Close anything using it — the harness included — and try again"
        ))
    })?;

    // The manifest carries the name too. The harness only reads it when it makes
    // the profile, so a stale one changes nothing today and misleads whoever
    // opens the file next.
    rename_in_manifest(&target, to)?;
    switches::rename(&from, to)?;
    selection::rename(&from, to)?;
    Ok(())
}

/// Take a profile away, with everything in it.
pub fn remove(name: &str) -> Result<()> {
    let name = expect_profile(name)?;
    if SHIPPED.contains(&name.as_str()) {
        return Err(Error::Profile(format!(
            "{name} is one of the harness's own profiles, and it would write a new one the next time it starts"
        )));
    }

    discard(&name)?;
    // Never leave the window pointed at a profile that is not there. The
    // fallback in `selected` would cover it, but a selection file naming a
    // deleted profile is a lie the next reader has to work out for themselves.
    selection::remove(&name)?;
    Ok(())
}

/// A profile as a file.
pub fn export(name: &str) -> Result<Declaration> {
    let name = expect_profile(name)?;
    let manifest = plugins::read_manifest(&paths::profile_dir(&name)).unwrap_or(Value::Null);

    let mut declaration = Declaration {
        kind: DECLARATION_KIND.to_string(),
        version: DECLARATION_VERSION,
        plugins: dependencies(&manifest),
        disabled: switches::switched_off(&name).into_iter().collect(),
        patch: patch(&name).unwrap_or_else(|| EMPTY_PATCH.to_string()),
        name,
        integrity: None,
        verified: true,
    };
    declaration.integrity = Some(declaration_integrity(&declaration)?);
    Ok(declaration)
}

/// Read an exported profile, without importing it.
///
/// Its own step so the manager can show what a file contains and let someone
/// name the profile before anything is written.
pub fn declaration(path: &Path) -> Result<Declaration> {
    let raw = std::fs::read(path).map_err(|cause| {
        Error::Profile(format!("{} could not be read: {cause}", path.display()))
    })?;
    if raw.len() > MAX_DECLARATION_BYTES {
        return Err(Error::Profile(format!(
            "{} is larger than the 2 MiB profile backup limit",
            path.display()
        )));
    }
    let mut declaration: Declaration = serde_json::from_slice(&raw).map_err(|cause| {
        Error::Profile(format!(
            "{} is not an exported profile: {cause}",
            path.display()
        ))
    })?;

    if declaration.kind != DECLARATION_KIND {
        return Err(Error::Profile(format!(
            "{} describes {}, not a profile",
            path.display(),
            declaration.kind
        )));
    }
    if !(LEGACY_DECLARATION_VERSION..=DECLARATION_VERSION).contains(&declaration.version) {
        return Err(Error::Profile(format!(
            "{} uses unsupported profile backup version {}",
            path.display(),
            declaration.version
        )));
    }
    if declaration.version == DECLARATION_VERSION {
        let offered = declaration.integrity.as_deref().ok_or_else(|| {
            Error::Profile(format!(
                "{} has no profile backup integrity value",
                path.display()
            ))
        })?;
        let actual = declaration_integrity(&declaration)?;
        if !offered.eq_ignore_ascii_case(&actual) {
            return Err(Error::Profile(format!(
                "{} failed its profile backup integrity check; it was not restored",
                path.display()
            )));
        }
        declaration.verified = true;
    }
    Ok(declaration)
}

fn declaration_integrity(declaration: &Declaration) -> Result<String> {
    let payload = DeclarationPayload {
        kind: &declaration.kind,
        version: declaration.version,
        name: &declaration.name,
        plugins: &declaration.plugins,
        disabled: &declaration.disabled,
        patch: &declaration.patch,
    };
    let encoded = serde_json::to_vec(&payload).map_err(|cause| {
        Error::Profile(format!(
            "the profile backup integrity value could not be calculated: {cause}"
        ))
    })?;
    Ok(format!("sha256:{}", hex(&Sha256::digest(encoded))))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Make a profile from an exported one, and say what it has to install.
///
/// The layer bundles come from this machine's own web profile rather than from
/// the file, which is what lets a profile exported from one harness version boot
/// under another: the packages that make a harness a harness belong to the
/// installation, and the file only ever spoke for the plugins.
pub fn import(declaration: &Declaration, name: &str) -> Result<Vec<String>> {
    let mut specs = Vec::with_capacity(declaration.plugins.len());
    for (package, range) in &declaration.plugins {
        let spec = format!("{package}@{range}");
        if !plugins::is_package_spec(&spec) {
            return Err(Error::Profile(format!(
                "the file asks for {package} from {range}, which this app will not pass to a package manager"
            )));
        }
        specs.push(spec);
    }

    let bundles = interface_bundles()?;
    // Only what the file also installs. A name switched off but not installed
    // would be a plugin the manager offers to switch on and cannot find.
    let off: BTreeSet<String> = declaration
        .disabled
        .iter()
        .filter(|package| declaration.plugins.contains_key(*package))
        .cloned()
        .collect();

    build(name, |dir| {
        initialize(
            dir,
            &bundles,
            &declaration.patch,
            workspace(DEFAULT).as_deref(),
        )?;
        if off.is_empty() {
            return Ok(());
        }
        switches::remember(name, &off)
    })?;
    Ok(specs)
}

/// Write a declaration where the user asked for it.
pub fn save(declaration: &Declaration, path: &Path) -> Result<()> {
    let mut json = serde_json::to_string_pretty(declaration).map_err(|cause| {
        Error::Profile(format!("the profile could not be written out: {cause}"))
    })?;
    json.push('\n');
    write(path, &json)
}

/// Put a half-made profile back, and forget it was ever there.
///
/// A copy missing what it was copying is not a copy, and leaving one behind
/// makes the user clean up after a failure they did not cause.
pub fn discard(name: &str) -> Result<()> {
    let dir = paths::profile_dir(name);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|cause| {
            Error::Profile(format!("{} could not be removed: {cause}", dir.display()))
        })?;
    }
    switches::forget(name)
}

/// Two profiles, package by package.
///
/// The difference nobody can see from the panel: it shows one profile at a time,
/// and the question anyone with two of them ends up asking is what one has that
/// the other does not.
pub fn compare(left: &str, right: &str) -> Result<Comparison> {
    let left = expect_profile(left)?;
    let right = expect_profile(right)?;
    let rows = differences(&inventory(&left), &inventory(&right));

    Ok(Comparison {
        differences: rows.iter().filter(|row| !row.same).count(),
        rows,
        left,
        right,
    })
}

/// One profile's plugin list, exactly as the panel would show it.
///
/// Through the panel's own reader rather than a second one, so a comparison can
/// never classify a plugin differently from the list it was read out of.
fn inventory(name: &str) -> Vec<InstalledPlugin> {
    match plugins::read_manifest(&paths::profile_dir(name)) {
        Some(manifest) => plugins::list(&manifest, &switches::switched_off(name)),
        None => Vec::new(),
    }
}

/// Line two plugin lists up by name.
fn differences(left: &[InstalledPlugin], right: &[InstalledPlugin]) -> Vec<Difference> {
    let names: BTreeSet<&str> = left
        .iter()
        .chain(right.iter())
        .map(|plugin| plugin.name.as_str())
        .collect();

    let mut rows: Vec<Difference> = names
        .into_iter()
        .map(|name| {
            let (found_left, found_right) = (find(left, name), find(right, name));
            let (left, right) = (standing(found_left), standing(found_right));
            let (left_spec, right_spec) = (spec(found_left), spec(found_right));

            Difference {
                name: name.to_string(),
                same: left == right && left_spec == right_spec,
                left,
                right,
                left_spec,
                right_spec,
            }
        })
        .collect();

    // What differs first. A comparison is read for its disagreements, and the
    // rows that agree are context — the same reason the panel puts what the user
    // installed above what came in the box.
    rows.sort_by(|left, right| {
        left.same
            .cmp(&right.same)
            .then_with(|| left.name.cmp(&right.name))
    });
    rows
}

fn find<'a>(plugins: &'a [InstalledPlugin], name: &str) -> Option<&'a InstalledPlugin> {
    plugins.iter().find(|plugin| plugin.name == name)
}

fn standing(plugin: Option<&InstalledPlugin>) -> Standing {
    match plugin {
        None => Standing::Absent,
        Some(plugin) if plugin.builtin => Standing::Builtin,
        Some(plugin) if plugin.disabled => Standing::Disabled,
        Some(plugin) if plugin.active => Standing::Active,
        Some(_) => Standing::Library,
    }
}

fn spec(plugin: Option<&InstalledPlugin>) -> String {
    plugin.map(|plugin| plugin.spec.clone()).unwrap_or_default()
}

/// What is in the profiles directory, sorted so the list never reshuffles.
fn scan() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(paths::profiles_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_name(name))
        .collect();
    names.sort();
    names
}

fn describe(name: &str, template: &[String]) -> Profile {
    let dir = paths::profile_dir(name);
    let manifest = plugins::read_manifest(&dir);
    let listed = manifest
        .as_ref()
        .map(|manifest| plugins::list(manifest, &switches::switched_off(name)))
        .unwrap_or_default();

    Profile {
        name: name.to_string(),
        initialized: manifest.is_some(),
        shipped: SHIPPED.contains(&name),
        serves_window: manifest.as_ref().is_some_and(|manifest| {
            let carried = bundles(manifest);
            template.iter().all(|bundle| carried.contains(bundle))
        }),
        plugins: listed.iter().filter(|plugin| !plugin.builtin).count(),
        disabled: listed.iter().filter(|plugin| plugin.disabled).count(),
        dir,
    }
}

/// The bundles the shipped web profile came with, in the order it lists them.
///
/// Order is kept because a layer stack is applied in order, and the base layer
/// being first is not an accident anybody should have to rediscover.
fn template_bundles() -> Vec<String> {
    let Some(manifest) = plugins::read_manifest(&paths::profile_dir(DEFAULT)) else {
        return Vec::new();
    };
    let installed = dependencies(&manifest);

    bundles(&manifest)
        .into_iter()
        .filter(|bundle| !installed.contains_key(bundle))
        .collect()
}

/// The layer list a manifest records, in the order it records it.
fn bundles(manifest: &Value) -> Vec<String> {
    manifest
        .pointer("/dsh/profile/bundles")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// What a manifest says was installed into the profile, as name → range.
fn dependencies(manifest: &Value) -> BTreeMap<String, String> {
    manifest
        .get("dependencies")
        .and_then(Value::as_object)
        .map(|dependencies| {
            dependencies
                .iter()
                .map(|(name, range)| (name.clone(), range.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Write a profile, and leave nothing behind if the writing fails.
///
/// A directory that exists but is not a profile is worse than no directory: the
/// next attempt at the same name is refused for a reason that has nothing to do
/// with what actually went wrong. The failure that gets reported is the first
/// one — a rollback that also fails has nothing more to tell anybody.
fn build<T>(name: &str, work: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    let dir = free_dir(name)?;
    match work(&dir) {
        Ok(made) => Ok(made),
        Err(failure) => {
            let _ = discard(name);
            Err(failure)
        }
    }
}

/// The bundles a profile needs to be one this window can show, or a sentence
/// saying where they would have come from.
fn interface_bundles() -> Result<Vec<String>> {
    let bundles = template_bundles();
    if bundles.is_empty() {
        return Err(Error::Profile(format!(
            "there is no {DEFAULT} profile to take the interface from yet; start the harness once and it will write one"
        )));
    }
    Ok(bundles)
}

/// Write a profile the harness can boot, and nothing more.
///
/// Three files, because that is what the harness's own initializer writes and
/// what its loader reads: the manifest with the layer list in it, a patch layer
/// for the user's own overrides, and the workspace file that decides how pnpm
/// lays out anything installed later. The workspace file is copied from a
/// profile the harness wrote rather than composed here — it is the installation's
/// file, and a copy of it cannot fall out of step with the installation.
fn initialize(dir: &Path, bundles: &[String], patch: &str, workspace: Option<&str>) -> Result<()> {
    std::fs::create_dir_all(dir)
        .map_err(|cause| Error::Profile(format!("{} could not be made: {cause}", dir.display())))?;

    // The harness names a profile's package after the directory it is in, so
    // this reads the name off the path for the same reason it does: they are the
    // same fact, and deriving it twice is how they end up disagreeing.
    let name = dir.file_name().unwrap_or_default().to_string_lossy();
    write_manifest(dir, &manifest(&name, bundles))?;
    write(&dir.join(PATCH), patch)?;
    if let Some(workspace) = workspace {
        write(&dir.join(WORKSPACE), workspace)?;
    }
    Ok(())
}

/// The manifest a new profile starts with.
fn manifest(name: &str, bundles: &[String]) -> Value {
    serde_json::json!({
        "name": format!("dsh-profile-{name}"),
        "private": true,
        "dependencies": {},
        "dsh": { "profile": { "bundles": bundles } }
    })
}

fn rename_in_manifest(dir: &Path, name: &str) -> Result<()> {
    let Some(mut manifest) = plugins::read_manifest(dir) else {
        return Ok(());
    };
    if let Some(slot) = manifest.get_mut("name") {
        *slot = Value::from(format!("dsh-profile-{name}"));
    }
    write_manifest(dir, &manifest)
}

/// Two-space JSON with a trailing newline, which is how every other writer of
/// this file leaves it — the harness's own included. A profile whose manifest
/// reformats itself depending on who touched it last is a diff nobody can read.
fn write_manifest(dir: &Path, manifest: &Value) -> Result<()> {
    let mut json = serde_json::to_string_pretty(manifest)
        .map_err(|cause| Error::Profile(format!("the manifest could not be written: {cause}")))?;
    json.push('\n');
    write(&dir.join(MANIFEST), &json)
}

fn write(path: &Path, contents: &str) -> Result<()> {
    crate::atomic::write(path, contents).map_err(|cause| {
        Error::Profile(format!("{} could not be written: {cause}", path.display()))
    })
}

/// A profile's patch layer, if it has one.
fn patch(name: &str) -> Option<String> {
    std::fs::read_to_string(paths::profile_dir(name).join(PATCH)).ok()
}

/// A profile's workspace file, if it has one.
fn workspace(name: &str) -> Option<String> {
    std::fs::read_to_string(paths::profile_dir(name).join(WORKSPACE)).ok()
}

pub use selection::RecoveryNotice as StartupRecoveryNotice;

/// Promote a candidate only after the Harness has announced readiness.
pub fn mark_healthy(name: &str) -> Result<()> {
    selection::mark_healthy(name)
}

/// Contain a failed candidate and return the protected profile to retry.
pub fn failed_start(name: &str, reason: &str) -> Result<Option<String>> {
    selection::failed(name, reason)
}

pub fn recovery_notice() -> Option<StartupRecoveryNotice> {
    selection::notice()
}

pub fn recovery_acknowledge() -> Result<()> {
    selection::acknowledge()
}

/// A name that is a profile on this machine, or a sentence saying it is not.
fn expect_profile(name: &str) -> Result<String> {
    if !is_name(name) {
        return Err(Error::Profile(format!("{name} is not a profile name")));
    }
    if !paths::profile_dir(name).is_dir() {
        return Err(Error::Profile(format!("there is no profile called {name}")));
    }
    Ok(name.to_string())
}

/// The directory a new profile will be written into, or a sentence saying why it
/// cannot be. Checked before anything is written, never after.
fn free_dir(name: &str) -> Result<PathBuf> {
    if !is_new_name(name) {
        return Err(Error::Profile(format!(
            "{name} cannot be a profile name; use lowercase letters, digits, - and _"
        )));
    }

    let dir = paths::profile_dir(name);
    if dir.exists() {
        return Err(Error::Profile(format!(
            "there is already a profile called {name}"
        )));
    }
    Ok(dir)
}

/// Whether a name is one this shell will treat as a profile at all.
///
/// The harness's own rule, and it is about the name being a directory under
/// `profiles/`: not empty, no path separator in it, not `.` or `..`, and not the
/// `node_modules` the harness keeps beside the profiles. A name that fails this
/// is not a profile however it got here, a hand-edited selection file included.
fn is_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && !name.contains(['/', '\\'])
        && name != SHARED_MODULES
}

/// Whether a name is one this shell will *make* a profile under.
///
/// Stricter, and about the manifest rather than the directory: the name goes
/// into `dsh-profile-<name>`, which is an npm package name, so what is allowed
/// here is what npm allows in one. Existing profiles are held to the looser rule
/// above, because a profile somebody made from a terminal is still theirs.
fn is_new_name(name: &str) -> bool {
    is_name(name)
        && !name.starts_with(['-', '_'])
        && name.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin(
        name: &str,
        spec: &str,
        active: bool,
        disabled: bool,
        builtin: bool,
    ) -> InstalledPlugin {
        InstalledPlugin {
            name: name.to_string(),
            spec: spec.to_string(),
            active,
            disabled,
            builtin,
            market_receipt: None,
        }
    }

    fn installed(name: &str, spec: &str) -> InstalledPlugin {
        plugin(name, spec, true, false, false)
    }

    fn came_with(name: &str) -> InstalledPlugin {
        plugin(name, "", true, false, true)
    }

    fn row<'a>(rows: &'a [Difference], name: &str) -> &'a Difference {
        rows.iter()
            .find(|row| row.name == name)
            .expect("a row for every package in either profile")
    }

    fn backup(version: u32) -> Declaration {
        Declaration {
            kind: DECLARATION_KIND.into(),
            version,
            name: "work".into(),
            plugins: BTreeMap::from([("@vendor/notes".into(), "1.2.3".into())]),
            disabled: vec!["@vendor/notes".into()],
            patch: "- name: notes\n".into(),
            integrity: None,
            verified: false,
        }
    }

    fn backup_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "dsh-studio-profile-backup-{label}-{}.json",
            std::process::id()
        ))
    }

    #[test]
    fn current_profile_backups_are_verified_before_restore_preview() {
        let mut file = backup(DECLARATION_VERSION);
        file.integrity = Some(declaration_integrity(&file).expect("digest"));
        let path = backup_path("verified");
        save(&file, &path).expect("backup");

        let read = declaration(&path).expect("verified backup");

        assert!(read.verified);
        assert!(read
            .integrity
            .as_deref()
            .is_some_and(|value| value.starts_with("sha256:")));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_tampered_profile_backup_is_refused_before_restore() {
        let mut file = backup(DECLARATION_VERSION);
        file.integrity = Some(declaration_integrity(&file).expect("digest"));
        let path = backup_path("tampered");
        save(&file, &path).expect("backup");
        let changed = std::fs::read_to_string(&path)
            .expect("backup text")
            .replace("1.2.3", "9.9.9");
        std::fs::write(&path, changed).expect("tamper");

        let failure = declaration(&path).expect_err("tamper must fail");

        assert!(failure.to_string().contains("integrity check"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn legacy_profile_backups_remain_readable_but_are_not_claimed_verified() {
        let path = backup_path("legacy");
        save(&backup(LEGACY_DECLARATION_VERSION), &path).expect("legacy backup");

        let read = declaration(&path).expect("legacy backup");

        assert!(!read.verified);
        assert!(read.integrity.is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unsupported_profile_backup_versions_are_refused() {
        for version in [0, DECLARATION_VERSION + 1] {
            let path = backup_path(&format!("version-{version}"));
            save(&backup(version), &path).expect("backup fixture");
            assert!(declaration(&path).is_err());
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn oversized_profile_backups_are_bounded_before_json_parsing() {
        let path = backup_path("oversized");
        std::fs::write(&path, vec![b' '; MAX_DECLARATION_BYTES + 1]).expect("large fixture");

        let failure = declaration(&path).expect_err("oversized backup");

        assert!(failure.to_string().contains("2 MiB"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_plugin_only_one_profile_has_is_absent_in_the_other() {
        let rows = differences(&[installed("@vendor/notes", "^1.2.0")], &[]);

        assert_eq!(rows.len(), 1);
        assert_eq!(row(&rows, "@vendor/notes").left, Standing::Active);
        assert_eq!(row(&rows, "@vendor/notes").right, Standing::Absent);
        assert!(!row(&rows, "@vendor/notes").same);
    }

    /// Both running it is not both running the same one.
    #[test]
    fn the_same_plugin_at_different_ranges_is_a_difference() {
        let rows = differences(
            &[installed("@vendor/notes", "^1.2.0")],
            &[installed("@vendor/notes", "^2.0.0")],
        );

        let row = row(&rows, "@vendor/notes");
        assert_eq!(row.left, Standing::Active);
        assert_eq!(row.right, Standing::Active);
        assert_eq!(
            (row.left_spec.as_str(), row.right_spec.as_str()),
            ("^1.2.0", "^2.0.0")
        );
        assert!(!row.same);
    }

    /// Installed in both, running in one. Invisible in the manifests, which both
    /// list the package under `dependencies`.
    #[test]
    fn switched_off_on_one_side_is_a_difference() {
        let rows = differences(
            &[installed("@vendor/notes", "^1.2.0")],
            &[plugin("@vendor/notes", "^1.2.0", false, true, false)],
        );

        assert_eq!(row(&rows, "@vendor/notes").right, Standing::Disabled);
        assert!(!row(&rows, "@vendor/notes").same);
    }

    #[test]
    fn a_library_is_not_a_layer() {
        let rows = differences(
            &[plugin("left-pad", "^1.3.0", false, false, false)],
            &[installed("left-pad", "^1.3.0")],
        );

        assert_eq!(row(&rows, "left-pad").left, Standing::Library);
        assert_eq!(row(&rows, "left-pad").right, Standing::Active);
    }

    #[test]
    fn what_both_profiles_came_with_agrees() {
        let rows = differences(
            &[came_with("@deepseek-ai/dsh-base")],
            &[came_with("@deepseek-ai/dsh-base")],
        );

        assert_eq!(row(&rows, "@deepseek-ai/dsh-base").left, Standing::Builtin);
        assert!(row(&rows, "@deepseek-ai/dsh-base").same);
    }

    #[test]
    fn what_differs_is_listed_before_what_agrees() {
        let rows = differences(
            &[
                came_with("@deepseek-ai/dsh-base"),
                installed("@vendor/notes", "^1.0.0"),
            ],
            &[came_with("@deepseek-ai/dsh-base")],
        );

        assert_eq!(
            rows.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(),
            ["@vendor/notes", "@deepseek-ai/dsh-base"]
        );
    }

    #[test]
    fn two_profiles_with_nothing_in_them_have_nothing_to_compare() {
        assert!(differences(&[], &[]).is_empty());
    }

    #[test]
    fn a_new_manifest_says_what_the_harness_would_have_said() {
        let written = manifest("work", &["@deepseek-ai/dsh-base".to_string()]);

        assert_eq!(written["name"], "dsh-profile-work");
        assert_eq!(written["private"], true);
        assert_eq!(written["dependencies"], serde_json::json!({}));
        assert_eq!(
            written["dsh"]["profile"]["bundles"],
            serde_json::json!(["@deepseek-ai/dsh-base"])
        );
        // The order the harness writes them in, which is the order a diff of the
        // file has to stay readable in.
        assert_eq!(
            written
                .as_object()
                .expect("an object")
                .keys()
                .collect::<Vec<_>>(),
            ["name", "private", "dependencies", "dsh"]
        );
    }

    #[test]
    fn a_profile_is_written_with_the_three_files_the_harness_reads() {
        let dir = std::env::temp_dir().join("dsh-studio-profiles-initialize");
        let _ = std::fs::remove_dir_all(&dir);
        let profile = dir.join("work");

        initialize(
            &profile,
            &["@deepseek-ai/dsh-base".to_string()],
            EMPTY_PATCH,
            Some("packages:\n  - .\n"),
        )
        .expect("a profile is written");

        let manifest = std::fs::read_to_string(profile.join(MANIFEST)).expect("a manifest");
        assert!(manifest.starts_with("{\n  \"name\": \"dsh-profile-work\""));
        assert!(manifest.ends_with("}\n"));
        assert_eq!(
            std::fs::read_to_string(profile.join(PATCH)).expect("a patch layer"),
            EMPTY_PATCH
        );
        assert_eq!(
            std::fs::read_to_string(profile.join(WORKSPACE)).expect("a workspace file"),
            "packages:\n  - .\n"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_web_profiles_drop_only_the_persisted_runtime_integration() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-profile-integration-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        initialize(
            &root,
            &[
                "@deepseek-ai/dsh-base".into(),
                WEB_APP_BUNDLE.into(),
                STUDIO_INTEGRATION.into(),
                "third-party-one".into(),
                STUDIO_INTEGRATION.into(),
                "third-party-two".into(),
            ],
            EMPTY_PATCH,
            Some(PROFILE_WORKSPACE),
        )
        .expect("profile");

        assert!(prepare_for_studio_in(&root, false).expect("migration"));
        assert!(prepare_for_studio_in(&root, false).expect("idempotent migration"));
        let manifest = plugins::read_manifest(&root).expect("manifest");
        assert_eq!(
            bundles(&manifest),
            [
                "@deepseek-ai/dsh-base",
                WEB_APP_BUNDLE,
                "third-party-one",
                "third-party-two",
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_web_profile_bootstraps_without_runtime_owned_layers() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-profile-bootstrap-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);

        assert!(prepare_for_studio_in(&root, true).expect("bootstrap"));
        let manifest = plugins::read_manifest(&root).expect("manifest");
        assert_eq!(bundles(&manifest), WEB_PROFILE_BUNDLES);
        assert_eq!(
            std::fs::read_to_string(root.join(WORKSPACE)).expect("workspace"),
            PROFILE_WORKSPACE
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_headless_profile_gets_no_studio_runtime_layer() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-profile-headless-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        initialize(&root, &["@deepseek-ai/dsh-base".into()], EMPTY_PATCH, None).expect("profile");

        assert!(!prepare_for_studio_in(&root, false).expect("headless profile"));
        let manifest = plugins::read_manifest(&root).expect("manifest");
        assert_eq!(bundles(&manifest), ["@deepseek-ai/dsh-base"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_private_runtime_module_is_materialized_in_the_shared_fallback() {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-profile-runtime-module-{}",
            std::process::id()
        ));
        let source = root.join("source");
        let target = root.join("profiles/node_modules/@moresyl/dsh-studio-integration");
        let _ = std::fs::remove_dir_all(&root);
        for (index, relative) in STUDIO_MODULE_FILES.iter().enumerate() {
            let file = source.join(relative);
            std::fs::create_dir_all(file.parent().expect("source parent"))
                .expect("source directory");
            std::fs::write(file, format!("generation-one-{index}")).expect("source module file");
        }

        sync_runtime_module_in(&source, &target).expect("first materialization");
        std::fs::write(source.join("lib/client.js"), "generation-two").expect("updated source");
        sync_runtime_module_in(&source, &target).expect("idempotent update");

        assert_eq!(
            std::fs::read_to_string(target.join("lib/client.js")).expect("copied client"),
            "generation-two"
        );
        assert!(STUDIO_MODULE_FILES
            .iter()
            .all(|relative| target.join(relative).is_file()));
        let _ = std::fs::remove_dir_all(root);
    }

    /// A profile with no workspace file of its own is written without one, and
    /// pnpm's defaults apply — not an empty file that would override them.
    #[test]
    fn a_profile_written_without_a_workspace_file_has_none() {
        let dir = std::env::temp_dir().join("dsh-studio-profiles-no-workspace");
        let _ = std::fs::remove_dir_all(&dir);
        let profile = dir.join("work");

        initialize(&profile, &[], EMPTY_PATCH, None).expect("a profile is written");

        assert!(!profile.join(WORKSPACE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_directories_beside_a_profile_are_not_profiles() {
        assert!(!is_name(SHARED_MODULES));
        assert!(!is_name(""));
        assert!(!is_name("."));
        assert!(!is_name(".."));
        assert!(!is_name(".hidden"));
        assert!(!is_name("../elsewhere"));
        assert!(!is_name("nested\\name"));
    }

    /// A profile made from a terminal is still the user's, whatever it is called.
    #[test]
    fn a_name_this_shell_would_not_choose_is_still_a_profile_it_lists() {
        assert!(is_name("Work.2024"));
        assert!(!is_new_name("Work.2024"));
    }

    #[test]
    fn a_new_name_has_to_be_one_npm_would_take() {
        assert!(is_new_name("work"));
        assert!(is_new_name("work-2"));
        assert!(is_new_name("work_2"));
        assert!(!is_new_name("Work"));
        assert!(!is_new_name("-work"));
        assert!(!is_new_name("_work"));
        assert!(!is_new_name("work 2"));
        assert!(!is_new_name("work.2"));
        assert!(!is_new_name(&"w".repeat(65)));
    }
}

//! Which Agent Preset the harness uses for new sessions.
//!
//! Harness releases before 0.1.7 discover preset directories and read
//! `agent-presets.default` from `settings.yaml`. Modern releases compose presets
//! as Profile rows and store the selection on `agent-preset-registry`. This
//! module preserves both contracts, converts valid legacy directories once, and
//! retains their source for portable import/export.
//!
//! All edits are narrow text patches. Cordis YAML can contain `!!js` expressions,
//! and a generic serializer would either reject them or rewrite unrelated rows
//! and comments. The migration therefore validates the list shape, preserves the
//! original composition bytes, backs up the Profile patch, and appends an owned,
//! idempotent section.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::paths;

/// A preset directory is one that holds this. The harness mounts the file; the
/// shell only needs to know it is there to know the directory is not scaffolding.
const COMPOSITION: &str = "agent.cordis.yml";

/// Display text, and nothing else. The harness deliberately keeps id and trust
/// out of it — those are facts about where the directory is, not claims it makes.
const METADATA: &str = "preset.yml";

/// Top-level key in the settings document, and the name the harness gives the
/// namespace it reads the default out of.
const NAMESPACE: &str = "agent-presets";

/// The one key inside it the shell writes.
const KEY: &str = "default";

const PACKAGE_KIND: &str = "dsh-agent-preset";
const PACKAGE_VERSION: u32 = 1;
const PACKAGE_MANIFEST: &str = "manifest.json";
const PACKAGE_PAYLOAD: &str = "preset/";
const PACKAGE_MAX_FILES: usize = 128;
const PACKAGE_MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024;
const PACKAGE_MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const PACKAGE_MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const LEGACY_SECTION_START: &str = "# dsh-studio legacy presets begin";
const LEGACY_SECTION_END: &str = "# dsh-studio legacy presets end";
const PROFILE_PATCH_BACKUP: &str = "cordis.patch.yml.pre-0.1.7-backup";
const BUILT_IN_PRESETS: [(&str, f64); 4] = [
    ("standard", 1.0),
    ("ptc", 2.0),
    ("minimal", 3.0),
    ("cordis", 4.0),
];

/// What the picker shows for one preset.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    /// Absent when there is no readable `preset.yml`, and then the id is the
    /// only thing there is to show.
    pub name: Option<String>,
    pub description: Option<String>,
    /// False for one the user wrote into their own preset directory.
    pub shipped: bool,
    /// Where the preset asked to sit. Not sent over the wire: the list arrives
    /// already in that order, and a second sort on the far side could only
    /// disagree with the first.
    #[serde(skip)]
    order: Option<f64>,
}

/// Everything the picker needs in one round trip.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Roster {
    pub presets: Vec<Preset>,
    /// What new sessions use now, which may name a preset that is not in the
    /// list — a settings document outlives the directory it points at.
    pub default: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageFile {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifest {
    kind: String,
    version: u32,
    id: String,
    files: Vec<PackageFile>,
}

/// Safe, bounded preview returned before an imported preset changes disk.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePreview {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub files: usize,
    pub bytes: u64,
    /// Internal archive integrity, not publisher identity or code trust.
    pub integrity_verified: bool,
}

/// The presets the harness shipped, inside its own install.
fn shipped_root() -> PathBuf {
    paths::harness_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("config")
        .join("agent-presets")
}

fn modern_runtime() -> bool {
    crate::harness::install::runtime_version(&paths::harness_dir())
        .and_then(|version| semver::Version::parse(&version).ok())
        .is_some_and(|version| (version.major, version.minor, version.patch) >= (0, 1, 7))
}

/// Where a preset the user wrote themselves goes.
fn user_root() -> PathBuf {
    paths::dsh_home().join(".agent-presets")
}

fn settings_file() -> PathBuf {
    paths::dsh_home().join("settings.yaml")
}

/// Whether a directory name is a preset id.
///
/// The harness's own rule, and it describes it as a containment boundary rather
/// than a style rule: an id ends up in paths and in a settings document, so the
/// characters it may contain are a safety property.
fn is_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit())
        && characters.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Read every preset the harness would offer, in the order it would offer them.
pub fn roster() -> Roster {
    let mut presets = Vec::new();
    let modern = modern_runtime();

    // Shipped first, which is also the precedence: the harness appends the user
    // root rather than prepending it, so a locally authored directory that
    // claimed a shipped id loses. Scanning in the same order with a
    // first-one-wins rule is the same answer, arrived at the same way.
    if modern {
        presets.extend(BUILT_IN_PRESETS.map(|(id, order)| Preset {
            id: id.to_string(),
            name: None,
            description: None,
            shipped: true,
            order: Some(order),
        }));
    } else {
        scan(&shipped_root(), true, false, &mut presets);
    }
    scan(&user_root(), false, modern, &mut presets);

    sort(&mut presets);

    Roster {
        presets,
        default: if modern {
            profile_default(&crate::profiles::selected()).or_else(current_default)
        } else {
            current_default()
        },
    }
}

/// Put the list in the order the harness would list it in.
///
/// Declared order first, the id as the tie-break. A preset that declares nothing
/// sorts after every preset that does, rather than to the front. The tie-break
/// compares bytes where the harness compares with the locale's collation; on an
/// id alphabet of lowercase ASCII and hyphens the two agree everywhere it matters.
fn sort(presets: &mut [Preset]) {
    let rank = |preset: &Preset| preset.order.unwrap_or(f64::INFINITY);
    presets.sort_by(|a, b| rank(a).total_cmp(&rank(b)).then_with(|| a.id.cmp(&b.id)));
}

/// Add every preset directory under `root` that is not already listed.
fn scan(root: &Path, shipped: bool, require_list: bool, into: &mut Vec<Preset>) {
    // No directory is the ordinary case for the user root, and for the shipped
    // root before the harness has been installed.
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let directory = entry.path();
        let Some(id) = directory.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !is_id(id) || into.iter().any(|preset| preset.id == id) {
            continue;
        }
        // The shell offers what will mount and says nothing about the rest. The
        // harness reports a directory whose composition is unloadable as a broken
        // row, because a skipped one still occupies its id; reproducing that here
        // would mean carrying a copy of its loader, so this checks only that the
        // file is present and leaves the diagnosis to the thing that mounts it.
        let composition = directory.join(COMPOSITION);
        if !composition.is_file()
            || (require_list
                && !crate::bounded_file::read_string(
                    &composition,
                    crate::bounded_file::CONTROL_BYTES,
                )
                .is_ok_and(|document| valid_composition(&document)))
        {
            continue;
        }

        let metadata = crate::bounded_file::read_string(
            &directory.join(METADATA),
            crate::bounded_file::CONTROL_BYTES,
        )
        .map(|raw| describe(&raw))
        .unwrap_or_default();

        into.push(Preset {
            id: id.to_string(),
            name: metadata.name,
            description: metadata.description,
            shipped,
            order: metadata.order,
        });
    }
}

/// The three display fields out of a `preset.yml`.
#[derive(Debug, Default, PartialEq)]
struct Description {
    name: Option<String>,
    description: Option<String>,
    order: Option<f64>,
}

/// Read those fields, without a YAML parser.
///
/// A decision about who writes this file rather than about YAML. The harness is
/// its only author: it dumps exactly these three keys with line wrapping switched
/// off, so every value sits on one line, and the only quoting it emits is a
/// single-quoted scalar with any interior quote doubled. Anything outside that
/// shape is reported as absent — the same answer the harness gives for metadata
/// it cannot load — so the worst this can do is list a preset under its id.
fn describe(raw: &str) -> Description {
    let mut described = Description::default();

    for line in raw.lines() {
        // Top level only. An indented line belongs to a structure this does not
        // claim to understand, and guessing at one is how it would start lying.
        if line.starts_with([' ', '\t', '#']) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let Some(value) = plain(value) else {
            continue;
        };

        match key_name(key).as_str() {
            "name" => described.name = Some(value),
            "description" => described.description = Some(value),
            "order" => described.order = value.parse().ok().filter(|n: &f64| n.is_finite()),
            _ => {}
        }
    }

    described
}

/// Characters a plain scalar cannot begin with.
///
/// The list is what turns "read the text after the colon" into something that
/// knows when it is out of its depth. A `>` or a `|` opens a block scalar whose
/// text is on the following lines; `&`, `*` and `!` open an anchor, an alias or a
/// tag; `[` and `{` open a flow collection; `#` is the start of a comment and so
/// means there was no value at all. Every one of them would otherwise be read as
/// the first character of a name. `-` is deliberately absent: it is only an
/// indicator before a space, and `order: -1` is a number.
const INDICATORS: [char; 14] = [
    '>', '|', '&', '*', '!', '[', ']', '{', '}', ',', '%', '@', '`', '#',
];

/// The text of a `key: value` line's value, or nothing when it is not one.
///
/// A quoted scalar comes back with its quoting taken off, and an unquoted one
/// comes back without any trailing comment. Anything that opens a structure comes
/// back as nothing, because the promise this module makes about a file it does not
/// fully parse is that it will say it found nothing rather than find the wrong
/// thing.
fn plain(value: &str) -> Option<String> {
    let value = value.trim();

    if value.starts_with(['\'', '"']) {
        return unquote(value);
    }
    if value.is_empty() || value.starts_with(INDICATORS) {
        return None;
    }

    // Only from an unquoted value: a `#` inside quotes is part of the text, and
    // the harness quotes anything that would need it.
    let text = match value.split_once(" #") {
        Some((before, _)) => before.trim_end(),
        None => value,
    };
    (!text.is_empty()).then(|| text.to_string())
}

/// Take the quoting off a scalar, or refuse if it is not quoted after all.
///
/// Both quotings the harness can emit, and both have to close: a value that opens
/// a quote and does not close it on this line is a multi-line scalar, which is
/// another structure this does not read.
fn unquote(value: &str) -> Option<String> {
    if let Some(inner) = value
        .strip_prefix('\'')
        .and_then(|rest| rest.strip_suffix('\''))
    {
        return Some(inner.replace("''", "'"));
    }
    value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .map(str::to_string)
}

/// A key as written, with any quoting taken off.
fn key_name(key: &str) -> String {
    let key = key.trim();
    unquote(key).unwrap_or_else(|| key.to_string())
}

/* -------------------------------------------------------------------------- */
/* The settings document                                                      */
/* -------------------------------------------------------------------------- */

/// Where `agent-presets.default` is, or where it would go.
#[derive(Debug, PartialEq)]
enum Slot {
    /// The line that already holds it, and the indent it is written at.
    Present { line: usize, indent: String },
    /// The block is there without the key; it goes after this line, at this
    /// indent.
    Insert { after: usize, indent: String },
    /// No block at all, so the whole thing has to be added.
    Absent,
    /// The block is there but not in a shape one line can be rewritten in.
    Opaque,
}

/// Whether this line opens the block.
///
/// The key is unquoted before comparing so that a document spelling it
/// `'agent-presets':` is recognised as the same key. Missing it would be worse
/// than cosmetic: the write below would append a second top-level
/// `agent-presets`, and a duplicate key is a document the harness refuses to
/// load rather than one it reads oddly.
fn opens_block(line: &str) -> bool {
    if line.starts_with([' ', '\t', '#']) {
        return false;
    }
    line.split_once(':')
        .is_some_and(|(key, _)| key_name(key) == NAMESPACE)
}

/// Whether the header carries a value of its own instead of opening a block.
fn is_block(line: &str) -> bool {
    line.split_once(':').is_some_and(|(_, rest)| {
        let rest = rest.trim();
        rest.is_empty() || rest.starts_with('#')
    })
}

fn locate(lines: &[&str]) -> Slot {
    let Some(header) = lines.iter().position(|line| opens_block(line)) else {
        return Slot::Absent;
    };

    // `agent-presets: {default: minimal}` is legal, means the same thing, and is
    // not something to rewrite by hand. Refusing leaves a document the user can
    // fix; guessing leaves one nothing can read.
    if !is_block(lines[header]) {
        return Slot::Opaque;
    }

    let mut base: Option<&str> = None;

    for (offset, line) in lines.iter().enumerate().skip(header + 1) {
        if line.trim().is_empty() {
            continue;
        }
        // A line that starts in column zero is the next top-level key, so the
        // block ended above it.
        let indent = &line[..line.len() - line.trim_start().len()];
        if indent.is_empty() {
            break;
        }

        let base = *base.get_or_insert(indent);
        // Deeper than the block's own members: part of one of them, not a
        // sibling of the key being looked for.
        if indent.len() > base.len() {
            continue;
        }
        if line
            .split_once(':')
            .is_some_and(|(key, _)| key_name(key) == KEY)
        {
            return Slot::Present {
                line: offset,
                indent: base.to_string(),
            };
        }
    }

    Slot::Insert {
        after: header,
        // Two spaces for a block with no members yet, which is what the harness
        // writes and what the rest of its document uses.
        indent: base.unwrap_or("  ").to_string(),
    }
}

/// What new sessions use now, as the document has it.
fn read_default(document: &str) -> Option<String> {
    let lines: Vec<&str> = document.lines().collect();
    let Slot::Present { line, .. } = locate(&lines) else {
        return None;
    };

    let (_, value) = lines[line].split_once(':')?;
    plain(value)
}

/// The id as a scalar the harness reads back as the string that was written.
///
/// An id is `[a-z0-9][a-z0-9-]*`, so most go in bare and the line looks like the
/// one the harness writes itself. The exceptions are ids YAML resolves to
/// something that is not a string: anything containing a digit could be a number
/// in some notation, and a short list of words are booleans or null. Those are
/// quoted, because the schema on the far side wants a string and would reject a
/// `false` that used to be a preset called `no`.
fn scalar(id: &str) -> String {
    const RESERVED: [&str; 9] = ["y", "n", "yes", "no", "on", "off", "true", "false", "null"];

    if id.contains(|c: char| c.is_ascii_digit()) || RESERVED.contains(&id) {
        format!("'{id}'")
    } else {
        id.to_string()
    }
}

/// Put `id` in as the default, leaving every other line of the document alone.
///
/// Split on the line feed alone so that every existing line — including the
/// carriage return of a CRLF document — is carried through untouched, and only
/// the lines this adds have to decide on an ending. Rewriting the endings of
/// lines nobody edited would show up as a change to the whole file.
fn edit(document: &str, id: &str) -> Result<String> {
    let mut lines: Vec<String> = if document.is_empty() {
        Vec::new()
    } else {
        document.split('\n').map(str::to_string).collect()
    };

    // Borrowed for the search and dropped before anything is inserted, because a
    // slot is line numbers into the list about to be edited. Trimmed here rather
    // than in `locate`, which has no business knowing about line endings.
    let slot = {
        let borrowed: Vec<&str> = lines
            .iter()
            .map(|line| line.trim_end_matches('\r'))
            .collect();
        locate(&borrowed)
    };

    let carriage = if document.contains("\r\n") { "\r" } else { "" };
    let key = |indent: &str| format!("{indent}{KEY}: {}{carriage}", scalar(id));

    match slot {
        Slot::Present { line, indent } => lines[line] = key(&indent),
        Slot::Insert { after, indent } => lines.insert(after + 1, key(&indent)),
        Slot::Absent => {
            // Splitting records a document's final newline as an empty last
            // element. Putting the block above it is what leaves the file ending
            // the way a file does.
            if !lines.last().is_some_and(String::is_empty) {
                lines.push(String::new());
            }
            let at = lines.len() - 1;
            lines.insert(at, format!("{NAMESPACE}:{carriage}"));
            lines.insert(at + 1, key("  "));
        }
        Slot::Opaque => {
            return Err(Error::Preset(format!(
                "{NAMESPACE} is written on one line in {}, so changing it here would mean \
                 rewriting the rest of that line — edit it by hand and the picker will follow",
                settings_file().display()
            )));
        }
    }

    Ok(lines.join("\n"))
}

/// Read the default out of the harness's settings document.
fn current_default() -> Option<String> {
    read_default(
        &crate::bounded_file::read_string(&settings_file(), crate::bounded_file::CONTROL_BYTES)
            .ok()?,
    )
}

fn profile_default(profile: &str) -> Option<String> {
    let document = crate::bounded_file::read_string(
        &paths::profile_dir(profile).join("cordis.patch.yml"),
        crate::bounded_file::CONTROL_BYTES,
    )
    .ok()?;
    read_profile_default(&document)
}

fn read_profile_default(document: &str) -> Option<String> {
    let lines = document.lines().collect::<Vec<_>>();
    let (start, end) = profile_entry(&lines, "agent-preset-registry")?;
    for key in ["selectedDefault", "default"] {
        if let Some(value) = lines[start + 1..end].iter().find_map(|line| {
            let trimmed = line.trim_start();
            let indent = line.len() - trimmed.len();
            (indent == 4)
                .then(|| trimmed.split_once(':'))
                .flatten()
                .filter(|(name, _)| *name == key)
                .and_then(|(_, value)| plain(value))
        }) {
            return Some(value);
        }
    }
    None
}

fn profile_entry(lines: &[&str], id: &str) -> Option<(usize, usize)> {
    let needle = format!("- id: {id}");
    let start = lines.iter().position(|line| line.trim_end() == needle)?;
    let end = lines[start + 1..]
        .iter()
        .position(|line| line.starts_with("- "))
        .map(|offset| start + 1 + offset)
        .unwrap_or(lines.len());
    Some((start, end))
}

/// Remove the empty sequence marker before turning an otherwise empty patch
/// into a list with rows. Comments are retained, including the explanatory
/// header written by the Harness profile template.
fn without_empty_sequence(document: &str) -> String {
    document
        .lines()
        .filter(|line| *line != "[]")
        .collect::<Vec<_>>()
        .join("\n")
}

/// Repair the exact invalid shape written by 0.9.16: an empty sequence followed
/// by list rows. A genuinely empty `[]` patch remains untouched.
fn repair_concatenated_empty_sequence(document: &str) -> String {
    let meaningful = document
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>();
    if meaningful.first() == Some(&"[]") && meaningful.len() > 1 {
        without_empty_sequence(document)
    } else {
        document.to_string()
    }
}

fn edit_profile_default(document: &str, id: &str) -> Result<String> {
    let document = without_empty_sequence(document);
    let mut lines = document.lines().map(str::to_string).collect::<Vec<_>>();
    let location = {
        let borrowed = lines.iter().map(String::as_str).collect::<Vec<_>>();
        profile_entry(&borrowed, "agent-preset-registry")
    };
    if let Some((start, mut end)) = location {
        let config = lines[start + 1..end]
            .iter()
            .position(|line| line == "  config:")
            .map(|offset| start + 1 + offset)
            .ok_or_else(|| {
                Error::Preset(
                    "the agent-preset-registry Profile row has no editable config block".into(),
                )
            })?;
        if let Some(offset) = lines[config + 1..end]
            .iter()
            .position(|line| line.trim_start().starts_with("selectedDefault:"))
        {
            lines[config + 1 + offset] = format!("    selectedDefault: {}", scalar(id));
        } else {
            lines.insert(config + 1, format!("    selectedDefault: {}", scalar(id)));
            end += 1;
        }
        if !lines[config + 1..end]
            .iter()
            .any(|line| line.trim_start().starts_with("default:"))
        {
            lines.insert(config + 1, "    default: standard".into());
        }
    } else {
        if !lines.is_empty() && !lines.last().is_some_and(String::is_empty) {
            lines.push(String::new());
        }
        lines.extend([
            "- id: agent-preset-registry".into(),
            "  config:".into(),
            "    default: standard".into(),
            format!("    selectedDefault: {}", scalar(id)),
        ]);
    }
    let mut edited = lines.join("\n");
    edited.push('\n');
    Ok(edited)
}

fn valid_composition(document: &str) -> bool {
    let document = document.strip_prefix('\u{feff}').unwrap_or(document);
    let mut row = false;
    for line in document.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if line.starts_with([' ', '\t']) {
            continue;
        }
        if !line.starts_with("- ") {
            return false;
        }
        row = true;
    }
    row
}

fn yaml_text(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

fn migrated_preset_patch(id: &str, composition: &str, metadata: &Description) -> String {
    let built_in = BUILT_IN_PRESETS
        .iter()
        .any(|(candidate, _)| candidate == &id);
    let mut fields = vec![format!("        id: {id}")];
    if let Some(name) = &metadata.name {
        fields.push(format!("        name: {}", yaml_text(name)));
    }
    if let Some(description) = &metadata.description {
        fields.push(format!("        description: {}", yaml_text(description)));
    }
    if let Some(order) = metadata.order {
        fields.push(format!("        order: {order}"));
    }
    let plugins = composition
        .trim_end()
        .lines()
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("          {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let (header, indent) = if built_in {
        (format!("- id: preset-{id}\n  config:"), "")
    } else {
        (
            format!(
                "- insert:\n    - id: preset-{id}\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:"
            ),
            "  ",
        )
    };
    let fields = fields
        .into_iter()
        .map(|line| format!("{indent}{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let plugins = plugins
        .lines()
        .map(|line| format!("{indent}{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{header}\n{fields}\n{indent}        plugins:\n{plugins}\n")
}

fn patch_has_preset(document: &str, id: &str) -> bool {
    let needle = format!("- id: preset-{id}");
    document
        .lines()
        .any(|line| line.trim_end() == needle || line.trim() == needle)
}

fn append_migrated_rows(document: &str, rows: &[(String, String)]) -> Result<String> {
    let start = document.find(LEGACY_SECTION_START);
    let end = document.find(LEGACY_SECTION_END);
    if start.is_some() != end.is_some() || start.zip(end).is_some_and(|(start, end)| end < start) {
        return Err(Error::Preset(
            "the legacy preset section in the Profile patch is incomplete".into(),
        ));
    }
    let pending = rows
        .iter()
        .filter(|(id, _)| !patch_has_preset(document, id))
        .map(|(_, patch)| patch.trim_end())
        .collect::<Vec<_>>();
    if pending.is_empty() {
        return Ok(document.to_string());
    }
    if let Some(end) = end {
        let additional = pending.iter().map(|row| row.len()).sum::<usize>();
        let mut edited = String::with_capacity(document.len() + additional);
        edited.push_str(&document[..end]);
        if !edited.ends_with('\n') {
            edited.push('\n');
        }
        edited.push_str(&pending.join("\n\n"));
        edited.push('\n');
        edited.push_str(&document[end..]);
        return Ok(edited);
    }

    let mut base = document.to_string();
    let meaningful = base
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>();
    if meaningful == ["[]"] {
        base = base
            .lines()
            .filter(|line| line.trim() != "[]")
            .collect::<Vec<_>>()
            .join("\n");
    }
    let mut edited = base.trim_end().to_string();
    if !edited.is_empty() {
        edited.push_str("\n\n");
    }
    edited.push_str(LEGACY_SECTION_START);
    edited.push('\n');
    edited.push_str(&pending.join("\n\n"));
    edited.push('\n');
    edited.push_str(LEGACY_SECTION_END);
    edited.push('\n');
    Ok(edited)
}

fn backup_profile_patch(profile_dir: &Path, document: &str) -> Result<()> {
    use std::fs::OpenOptions;

    let path = profile_dir.join(PROFILE_PATCH_BACKUP);
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => file.write_all(document.as_bytes()).map_err(|cause| {
            Error::Preset(format!(
                "{} could not be backed up: {cause}",
                path.display()
            ))
        }),
        Err(cause) if cause.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(cause) => Err(Error::Preset(format!(
            "{} could not be backed up: {cause}",
            path.display()
        ))),
    }
}

fn migrate_legacy_profile_in(home: &Path, profile_dir: &Path) -> Result<usize> {
    let root = home.join(".agent-presets");
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => Some(entries),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => None,
        Err(cause) => {
            return Err(Error::Preset(format!(
                "{} could not be read for migration: {cause}",
                root.display()
            )));
        }
    };
    let mut directories = entries.into_iter().flatten().flatten().collect::<Vec<_>>();
    directories.sort_by_key(|entry| entry.file_name());
    let mut rows = Vec::new();
    for entry in directories {
        let id = entry.file_name().to_string_lossy().to_string();
        if !is_id(&id)
            || !entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
        {
            continue;
        }
        let composition = match crate::bounded_file::read_string(
            &entry.path().join(COMPOSITION),
            crate::bounded_file::CONTROL_BYTES,
        ) {
            Ok(composition) if valid_composition(&composition) => composition,
            _ => continue,
        };
        let metadata = crate::bounded_file::read_string(
            &entry.path().join(METADATA),
            crate::bounded_file::CONTROL_BYTES,
        )
        .map(|raw| describe(&raw))
        .unwrap_or_default();
        rows.push((
            id.clone(),
            migrated_preset_patch(&id, &composition, &metadata),
        ));
    }
    let legacy_default = crate::bounded_file::read_string(
        &home.join("settings.yaml"),
        crate::bounded_file::CONTROL_BYTES,
    )
    .ok()
    .and_then(|document| read_default(&document))
    .filter(|id| {
        is_id(id)
            && (BUILT_IN_PRESETS
                .iter()
                .any(|(candidate, _)| candidate == id)
                || rows.iter().any(|(candidate, _)| candidate == id))
    });
    std::fs::create_dir_all(profile_dir).map_err(|cause| {
        Error::Preset(format!(
            "{} could not be prepared for preset migration: {cause}",
            profile_dir.display()
        ))
    })?;
    let patch_path = profile_dir.join("cordis.patch.yml");
    let previous =
        match crate::bounded_file::read_string(&patch_path, crate::bounded_file::CONTROL_BYTES) {
            Ok(document) => document,
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => "[]\n".into(),
            Err(cause) => {
                return Err(Error::Preset(format!(
                    "{} could not be read safely: {cause}",
                    patch_path.display()
                )));
            }
        };
    let repaired = repair_concatenated_empty_sequence(&previous);
    let mut migrated = append_migrated_rows(&repaired, &rows)?;
    if read_profile_default(&migrated).is_none() {
        if let Some(default) = legacy_default {
            migrated = edit_profile_default(&migrated, &default)?;
        }
    }
    if migrated == previous {
        return Ok(0);
    }
    backup_profile_patch(profile_dir, &previous)?;
    crate::atomic::write(&patch_path, migrated).map_err(|cause| {
        Error::Preset(format!(
            "{} could not publish migrated presets: {cause}",
            patch_path.display()
        ))
    })?;
    Ok(rows
        .iter()
        .filter(|(id, _)| !patch_has_preset(&previous, id))
        .count())
}

/// Publish legacy directory presets into the selected modern Profile.
/// The source tree is retained as the portable-package authority.
pub fn migrate_legacy_profile(profile: &str) -> Result<usize> {
    if !modern_runtime() {
        return Ok(0);
    }
    migrate_legacy_profile_in(&paths::dsh_home(), &paths::profile_dir(profile))
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

#[tauri::command]
pub fn preset_roster() -> Roster {
    roster()
}

/// Make `id` what new sessions start as.
///
/// Live sessions keep the preset they were made with, which is the harness's
/// behaviour and not a limitation of writing the file underneath it: it re-reads
/// the key per session rather than caching it, so this takes effect at the next
/// one and disturbs nothing that is already running.
#[tauri::command]
pub fn preset_choose(id: String) -> Result<Roster> {
    // Checked here and not only trusted from the list, because this is the point
    // where a string becomes part of a file the harness parses.
    if !is_id(&id) {
        return Err(Error::Preset(format!("{id} is not an agent preset id")));
    }
    let available = roster();
    if !available.presets.iter().any(|preset| preset.id == id) {
        return Err(Error::Preset(format!(
            "there is no agent preset called {id}"
        )));
    }

    if modern_runtime() {
        let profile = crate::profiles::selected();
        migrate_legacy_profile(&profile)?;
        let profile_dir = paths::profile_dir(&profile);
        let path = profile_dir.join("cordis.patch.yml");
        let document = crate::bounded_file::read_string(&path, crate::bounded_file::CONTROL_BYTES)
            .map_err(|cause| {
                Error::Preset(format!(
                    "{} could not be read safely: {cause}",
                    path.display()
                ))
            })?;
        let edited = edit_profile_default(&document, &id)?;
        backup_profile_patch(&profile_dir, &document)?;
        crate::atomic::write(&path, edited).map_err(|cause| {
            Error::Preset(format!("{} could not be written: {cause}", path.display()))
        })?;
        return Ok(roster());
    }

    let path = settings_file();
    // A missing document is the first-run case, not a failure: the harness
    // creates it when it first needs to write something, and until then the
    // default is whatever its own configuration says.
    let document = match crate::bounded_file::read_string(&path, crate::bounded_file::CONTROL_BYTES)
    {
        Ok(document) => document,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(cause) => {
            return Err(Error::Preset(format!(
                "{} could not be read safely: {cause}",
                path.display()
            )));
        }
    };
    let edited = edit(&document, &id)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|cause| {
            Error::Preset(format!(
                "{} could not be created: {cause}",
                parent.display()
            ))
        })?;
    }
    crate::atomic::write(&path, edited).map_err(|cause| {
        Error::Preset(format!("{} could not be written: {cause}", path.display()))
    })?;

    Ok(roster())
}

/// Export one user-authored preset as a portable, integrity-described package.
#[tauri::command]
pub fn preset_export(id: String, path: PathBuf) -> Result<()> {
    export_from(&user_root(), &id, &path)
}

/// Verify every archive entry and checksum without writing a preset.
#[tauri::command]
pub fn preset_package(path: PathBuf) -> Result<PackagePreview> {
    inspect_package(&path).map(|package| package.preview)
}

/// Verify again and atomically install a portable preset into the user root.
#[tauri::command]
pub fn preset_import(path: PathBuf) -> Result<Roster> {
    import_into(&path, &user_root())?;
    if modern_runtime() {
        migrate_legacy_profile(&crate::profiles::selected())?;
    }
    Ok(roster())
}

struct InspectedPackage {
    manifest: PackageManifest,
    preview: PackagePreview,
}

fn export_from(root: &Path, id: &str, destination: &Path) -> Result<()> {
    if !is_id(id) {
        return Err(Error::Preset(format!("{id} is not an agent preset id")));
    }
    let source = root.join(id);
    if !safe_directory(&source) || !source.join(COMPOSITION).is_file() {
        return Err(Error::Preset(format!(
            "there is no user-authored preset called {id}"
        )));
    }
    let files = collect_files(&source)?;
    let manifest = PackageManifest {
        kind: PACKAGE_KIND.into(),
        version: PACKAGE_VERSION,
        id: id.into(),
        files,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|cause| Error::Preset(format!("preset package manifest failed: {cause}")))?;
    if manifest_bytes.len() as u64 > PACKAGE_MAX_MANIFEST_BYTES {
        return Err(Error::Preset("preset package manifest is too large".into()));
    }

    let (temporary, file) = crate::atomic::stage(destination)
        .map_err(|cause| Error::Preset(format!("preset package could not be staged: {cause}")))?;
    let result = write_package(file, &source, &manifest, &manifest_bytes);
    if let Err(failure) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(failure);
    }
    if let Err(cause) = crate::atomic::replace(&temporary, destination) {
        let _ = std::fs::remove_file(temporary);
        return Err(Error::Preset(format!(
            "preset package could not be published: {cause}"
        )));
    }
    Ok(())
}

fn write_package(
    file: std::fs::File,
    source: &Path,
    manifest: &PackageManifest,
    manifest_bytes: &[u8],
) -> Result<()> {
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    zip.start_file(PACKAGE_MANIFEST, options)
        .and_then(|_| {
            zip.write_all(manifest_bytes)
                .map_err(zip::result::ZipError::Io)
        })
        .map_err(package_write_error)?;
    for entry in &manifest.files {
        let relative = safe_relative(&entry.path)?;
        let bytes = crate::bounded_file::read(&source.join(&relative), entry.size as usize)
            .map_err(|cause| {
                Error::Preset(format!(
                    "preset file {} could not be read: {cause}",
                    entry.path
                ))
            })?;
        zip.start_file(format!("{PACKAGE_PAYLOAD}{}", entry.path), options)
            .and_then(|_| zip.write_all(&bytes).map_err(zip::result::ZipError::Io))
            .map_err(package_write_error)?;
    }
    zip.finish().map(|_| ()).map_err(package_write_error)
}

fn package_write_error(cause: zip::result::ZipError) -> Error {
    Error::Preset(format!("preset package could not be written: {cause}"))
}

fn collect_files(root: &Path) -> Result<Vec<PackageFile>> {
    fn visit(root: &Path, directory: &Path, files: &mut Vec<PackageFile>) -> Result<()> {
        let entries = std::fs::read_dir(directory).map_err(|cause| {
            Error::Preset(format!(
                "{} could not be read: {cause}",
                directory.display()
            ))
        })?;
        for entry in entries {
            let entry = entry.map_err(|cause| {
                Error::Preset(format!("preset directory could not be read: {cause}"))
            })?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|cause| {
                Error::Preset(format!(
                    "{} could not be inspected: {cause}",
                    path.display()
                ))
            })?;
            if metadata.file_type().is_symlink() {
                return Err(Error::Preset(format!(
                    "preset packages cannot contain links: {}",
                    path.display()
                )));
            }
            if metadata.is_dir() {
                visit(root, &path, files)?;
                continue;
            }
            if !metadata.is_file() {
                return Err(Error::Preset(format!(
                    "preset packages can contain only regular files: {}",
                    path.display()
                )));
            }
            if files.len() == PACKAGE_MAX_FILES {
                return Err(Error::Preset(format!(
                    "preset package exceeds the {PACKAGE_MAX_FILES} file limit"
                )));
            }
            if metadata.len() > PACKAGE_MAX_ENTRY_BYTES {
                return Err(Error::Preset(format!(
                    "preset file {} exceeds the 4 MiB limit",
                    path.display()
                )));
            }
            let used = files.iter().map(|file| file.size).sum::<u64>();
            if used.saturating_add(metadata.len()) > PACKAGE_MAX_TOTAL_BYTES {
                return Err(Error::Preset(
                    "preset package exceeds the 16 MiB uncompressed limit".into(),
                ));
            }
            let relative = path.strip_prefix(root).map_err(|_| {
                Error::Preset(format!("{} escaped the preset root", path.display()))
            })?;
            let portable = portable_relative(relative)?;
            let bytes =
                crate::bounded_file::read(&path, metadata.len() as usize).map_err(|cause| {
                    Error::Preset(format!("{} could not be read: {cause}", path.display()))
                })?;
            files.push(PackageFile {
                path: portable,
                size: bytes.len() as u64,
                sha256: format!("sha256:{:x}", Sha256::digest(&bytes)),
            });
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    if !files.iter().any(|file| file.path == COMPOSITION) {
        return Err(Error::Preset(format!(
            "preset has no required {COMPOSITION}"
        )));
    }
    Ok(files)
}

fn inspect_package(path: &Path) -> Result<InspectedPackage> {
    let file = std::fs::File::open(path)
        .map_err(|cause| Error::Preset(format!("preset package could not be opened: {cause}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|cause| Error::Preset(format!("preset package is not a readable zip: {cause}")))?;
    if archive.len() > PACKAGE_MAX_FILES + 1 {
        return Err(Error::Preset(format!(
            "preset package exceeds the {} entry limit",
            PACKAGE_MAX_FILES + 1
        )));
    }
    let manifest_bytes = {
        let entry = archive
            .by_name(PACKAGE_MANIFEST)
            .map_err(|_| Error::Preset(format!("preset package has no {PACKAGE_MANIFEST}")))?;
        if entry.size() > PACKAGE_MAX_MANIFEST_BYTES || entry.is_dir() || entry_is_link(&entry) {
            return Err(Error::Preset("preset package manifest is unsafe".into()));
        }
        let mut bytes = Vec::new();
        entry
            .take(PACKAGE_MAX_MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|cause| {
                Error::Preset(format!("preset manifest could not be read: {cause}"))
            })?;
        bytes
    };
    let manifest: PackageManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|cause| Error::Preset(format!("preset manifest is invalid: {cause}")))?;
    validate_manifest(&manifest)?;

    let mut seen = std::collections::BTreeSet::new();
    let mut metadata = None;
    let mut total = 0_u64;
    for file in &manifest.files {
        let name = format!("{PACKAGE_PAYLOAD}{}", file.path);
        let entry = archive
            .by_name(&name)
            .map_err(|_| Error::Preset(format!("preset package is missing {}", file.path)))?;
        if entry.is_dir() || entry_is_link(&entry) || entry.size() != file.size {
            return Err(Error::Preset(format!(
                "preset package entry {} is unsafe or has the wrong size",
                file.path
            )));
        }
        let mut bytes = Vec::new();
        entry
            .take(PACKAGE_MAX_ENTRY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|cause| Error::Preset(format!("{} could not be read: {cause}", file.path)))?;
        let digest = format!("sha256:{:x}", Sha256::digest(&bytes));
        if digest != file.sha256 {
            return Err(Error::Preset(format!(
                "preset package integrity check failed for {}",
                file.path
            )));
        }
        if file.path == COMPOSITION
            && !std::str::from_utf8(&bytes)
                .map(valid_composition)
                .unwrap_or(false)
        {
            return Err(Error::Preset(
                "preset composition must contain a YAML plugin list".into(),
            ));
        }
        total = total.saturating_add(bytes.len() as u64);
        seen.insert(name);
        if file.path == METADATA {
            metadata = std::str::from_utf8(&bytes).ok().map(describe);
        }
    }
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|cause| {
            Error::Preset(format!("preset archive entry could not be read: {cause}"))
        })?;
        let name = entry.name();
        if name != PACKAGE_MANIFEST && !seen.contains(name) {
            return Err(Error::Preset(format!(
                "preset package contains undeclared entry {name}"
            )));
        }
    }
    let metadata = metadata.unwrap_or_default();
    Ok(InspectedPackage {
        preview: PackagePreview {
            id: manifest.id.clone(),
            name: metadata.name,
            description: metadata.description,
            files: manifest.files.len(),
            bytes: total,
            integrity_verified: true,
        },
        manifest,
    })
}

fn validate_manifest(manifest: &PackageManifest) -> Result<()> {
    if manifest.kind != PACKAGE_KIND || manifest.version != PACKAGE_VERSION {
        return Err(Error::Preset(format!(
            "preset package is not {PACKAGE_KIND} version {PACKAGE_VERSION}"
        )));
    }
    if !is_id(&manifest.id) {
        return Err(Error::Preset("preset package id is invalid".into()));
    }
    if manifest.files.is_empty() || manifest.files.len() > PACKAGE_MAX_FILES {
        return Err(Error::Preset("preset package file count is invalid".into()));
    }
    let mut paths = std::collections::BTreeSet::new();
    let mut total = 0_u64;
    for file in &manifest.files {
        safe_relative(&file.path)?;
        if !paths.insert(file.path.clone()) {
            return Err(Error::Preset(format!(
                "preset package declares {} more than once",
                file.path
            )));
        }
        if file.size > PACKAGE_MAX_ENTRY_BYTES {
            return Err(Error::Preset(format!(
                "preset package entry {} exceeds the 4 MiB limit",
                file.path
            )));
        }
        total = total.saturating_add(file.size);
        if total > PACKAGE_MAX_TOTAL_BYTES {
            return Err(Error::Preset(
                "preset package exceeds the 16 MiB uncompressed limit".into(),
            ));
        }
        let digest = file.sha256.strip_prefix("sha256:").unwrap_or_default();
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::Preset(format!(
                "preset package digest is invalid for {}",
                file.path
            )));
        }
    }
    if !paths.contains(COMPOSITION) {
        return Err(Error::Preset(format!(
            "preset package has no required {COMPOSITION}"
        )));
    }
    Ok(())
}

fn import_into(package: &Path, root: &Path) -> Result<String> {
    let inspected = inspect_package(package)?;
    std::fs::create_dir_all(root).map_err(|cause| {
        Error::Preset(format!("{} could not be created: {cause}", root.display()))
    })?;
    let target = root.join(&inspected.manifest.id);
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(Error::Preset(format!(
            "a preset called {} already exists; remove or rename it before importing",
            inspected.manifest.id
        )));
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = root.join(format!(
        ".{}.importing-{}-{nonce}",
        inspected.manifest.id,
        std::process::id()
    ));
    std::fs::create_dir(&staging)
        .map_err(|cause| Error::Preset(format!("preset import could not be staged: {cause}")))?;
    let outcome = extract_package(package, &staging, &inspected.manifest)
        .and_then(|_| {
            std::fs::rename(&staging, &target).map_err(|cause| {
                Error::Preset(format!("preset import could not be activated: {cause}"))
            })
        })
        .map(|_| inspected.manifest.id);
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(staging);
    }
    outcome
}

fn extract_package(path: &Path, staging: &Path, manifest: &PackageManifest) -> Result<()> {
    let file = std::fs::File::open(path)
        .map_err(|cause| Error::Preset(format!("preset package could not be reopened: {cause}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|cause| Error::Preset(format!("preset package could not be reopened: {cause}")))?;
    for file in &manifest.files {
        let relative = safe_relative(&file.path)?;
        let target = staging.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|cause| {
                Error::Preset(format!("preset directory could not be created: {cause}"))
            })?;
        }
        let entry = archive
            .by_name(&format!("{PACKAGE_PAYLOAD}{}", file.path))
            .map_err(|_| Error::Preset(format!("preset package is missing {}", file.path)))?;
        let mut bytes = Vec::new();
        entry
            .take(file.size + 1)
            .read_to_end(&mut bytes)
            .map_err(|cause| Error::Preset(format!("{} could not be read: {cause}", file.path)))?;
        crate::atomic::write(&target, bytes).map_err(|cause| {
            Error::Preset(format!(
                "{} could not be installed: {cause}",
                target.display()
            ))
        })?;
    }
    Ok(())
}

fn safe_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

fn portable_relative(path: &Path) -> Result<String> {
    let checked = safe_relative(&path.to_string_lossy().replace('\\', "/"))?;
    Ok(checked
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn safe_relative(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.contains('\\') || value.starts_with('/') {
        return Err(Error::Preset(format!(
            "preset package path is unsafe: {value}"
        )));
    }
    let path = Path::new(value);
    if path.components().any(|component| {
        !matches!(component, Component::Normal(_)) || component.as_os_str().is_empty()
    }) {
        return Err(Error::Preset(format!(
            "preset package path is unsafe: {value}"
        )));
    }
    Ok(path.to_path_buf())
}

fn entry_is_link(entry: &zip::read::ZipFile<'_, std::fs::File>) -> bool {
    entry
        .unix_mode()
        .is_some_and(|mode| mode & 0o170000 == 0o120000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package_fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "dsh-studio-preset-package-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("fixture root");
        (root.join("users"), root.join("portable.dshpreset"), root)
    }

    /// A `preset.yml` exactly as the harness ships it, Chinese text and all.
    const SHIPPED: &str = "name: 标准模式\ndescription: 功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。\norder: 1\n";

    #[test]
    fn a_shipped_metadata_file_reads() {
        assert_eq!(
            describe(SHIPPED),
            Description {
                name: Some("标准模式".to_string()),
                description: Some(
                    "功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。"
                        .to_string()
                ),
                order: Some(1.0),
            }
        );
    }

    #[test]
    fn quoting_comes_off_and_a_doubled_quote_comes_back() {
        let described = describe("name: 'it''s here: really'\n");
        assert_eq!(described.name.as_deref(), Some("it's here: really"));
    }

    #[test]
    fn a_field_this_cannot_read_is_absent_rather_than_wrong() {
        // A folded scalar is legal YAML and outside what this claims to parse.
        // Reporting nothing puts the preset in the list under its id; guessing
        // would put the wrong words on it.
        let described = describe("name: >\n  wrapped\norder: soon\n");
        assert_eq!(described, Description::default());
    }

    /// The settings document on a machine that has run the harness.
    const SETTINGS: &str = "ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nagent-presets:\n  default: standard\n";

    #[test]
    fn the_default_is_read_out_of_the_block() {
        assert_eq!(read_default(SETTINGS).as_deref(), Some("standard"));
    }

    #[test]
    fn a_key_in_another_namespace_is_not_the_default() {
        // `welcomeNoticeVersion` is somebody else's key and `default` under it
        // would be too. Only the one in this namespace counts.
        let document = "other:\n  default: wrong\n";
        assert_eq!(read_default(document), None);
    }

    #[test]
    fn a_comment_after_the_value_is_not_part_of_it() {
        let document = "agent-presets:\n  default: standard # picked in the guide\n";
        assert_eq!(read_default(document).as_deref(), Some("standard"));
    }

    #[test]
    fn writing_the_default_changes_one_line() {
        let edited = edit(SETTINGS, "minimal").expect("an editable document");
        assert_eq!(
            edited,
            "ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nagent-presets:\n  default: minimal\n"
        );
    }

    #[test]
    fn everything_the_harness_wrote_around_the_key_survives() {
        // The reason this module rewrites a line instead of round-tripping the
        // document: comments, blank lines, key order and quoting style are all
        // somebody else's, and a diff that touched them would be a change nobody
        // made.
        let document = "# how sessions start\nui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n\nagent-presets:\n  # what a new session is\n  default: standard\n  other: kept\n";
        let edited = edit(document, "cordis").expect("an editable document");
        assert_eq!(
            edited,
            document.replace("default: standard", "default: cordis")
        );
    }

    #[test]
    fn a_block_without_the_key_gains_it() {
        let document = "agent-presets:\n  other: kept\n";
        let edited = edit(document, "code").expect("an editable document");
        assert_eq!(edited, "agent-presets:\n  default: code\n  other: kept\n");
    }

    #[test]
    fn a_document_without_the_block_gains_one() {
        let document = "ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n";
        let edited = edit(document, "minimal").expect("an editable document");
        assert_eq!(
            edited,
            "ui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\nagent-presets:\n  default: minimal\n"
        );
    }

    #[test]
    fn a_document_that_is_not_there_yet_becomes_one() {
        assert_eq!(
            edit("", "standard").expect("a new document"),
            "agent-presets:\n  default: standard\n"
        );
    }

    #[test]
    fn a_flow_mapping_is_refused_rather_than_mangled() {
        let document = "agent-presets: {default: standard}\n";
        assert!(edit(document, "minimal").is_err());
    }

    #[test]
    fn the_line_endings_the_document_came_with_are_the_ones_it_keeps() {
        let document = "ui-onboarding:\r\n  welcomeNoticeVersion: 1\r\nagent-presets:\r\n  default: standard\r\n";
        let edited = edit(document, "code").expect("an editable document");
        assert_eq!(
            edited,
            "ui-onboarding:\r\n  welcomeNoticeVersion: 1\r\nagent-presets:\r\n  default: code\r\n"
        );
    }

    #[test]
    fn the_indent_the_block_already_uses_is_the_one_written() {
        let document = "agent-presets:\n    other: kept\n";
        let edited = edit(document, "code").expect("an editable document");
        assert_eq!(
            edited,
            "agent-presets:\n    default: code\n    other: kept\n"
        );
    }

    #[test]
    fn an_id_yaml_would_read_as_something_else_is_quoted() {
        assert_eq!(scalar("standard"), "standard");
        assert_eq!(scalar("my-preset"), "my-preset");
        // Would come back as the boolean, and the schema wants a string.
        assert_eq!(scalar("no"), "'no'");
        // Would come back as a number.
        assert_eq!(scalar("2"), "'2'");
        assert_eq!(scalar("0x1f"), "'0x1f'");
    }

    #[test]
    fn a_quoted_default_reads_back_as_the_id_that_was_written() {
        let edited = edit("", "no").expect("a new document");
        assert_eq!(read_default(&edited).as_deref(), Some("no"));
    }

    #[test]
    fn only_the_harness_id_shape_is_a_preset() {
        assert!(is_id("standard"));
        assert!(is_id("my-preset-2"));
        assert!(!is_id(""));
        assert!(!is_id("-leading"));
        assert!(!is_id("Upper"));
        assert!(!is_id("has space"));
        // The two directory names that would matter most to get wrong.
        assert!(!is_id("."));
        assert!(!is_id(".."));
    }

    #[test]
    fn presets_are_listed_in_the_order_they_asked_for() {
        let preset = |id: &str, order: Option<f64>| Preset {
            id: id.to_string(),
            name: None,
            description: None,
            shipped: true,
            order,
        };
        let mut presets = vec![
            preset("undeclared", None),
            preset("cordis", Some(4.0)),
            preset("standard", Some(1.0)),
            preset("also-undeclared", None),
            preset("code", Some(2.0)),
        ];
        sort(&mut presets);

        let order: Vec<&str> = presets.iter().map(|preset| preset.id.as_str()).collect();
        assert_eq!(
            order,
            [
                "standard",
                "code",
                "cordis",
                "also-undeclared",
                "undeclared"
            ]
        );
    }

    #[test]
    fn modern_profile_default_is_added_and_updated_without_touching_other_rows() {
        let original = "- id: untouched\n  disabled: true\n";
        let first = edit_profile_default(original, "custom").expect("default row");
        assert!(first.contains("- id: untouched\n  disabled: true"));
        assert!(first.contains("- id: agent-preset-registry"));
        assert!(first.contains("    default: standard"));
        assert!(first.contains("    selectedDefault: custom"));

        let updated = edit_profile_default(&first, "minimal").expect("updated default");
        assert_eq!(updated.matches("- id: agent-preset-registry").count(), 1);
        assert!(updated.contains("    selectedDefault: minimal"));
        assert!(!updated.contains("selectedDefault: custom"));
    }

    #[test]
    fn modern_profile_default_replaces_an_empty_sequence_instead_of_appending_to_it() {
        let original = "# profile patch\n[]\n";
        let edited = edit_profile_default(original, "cordis").expect("default row");

        assert_eq!(
            edited,
            "# profile patch\n\n- id: agent-preset-registry\n  config:\n    default: standard\n    selectedDefault: cordis\n"
        );
        assert!(!edited.lines().any(|line| line == "[]"));
    }

    #[test]
    fn migration_repairs_the_invalid_patch_written_by_0_9_16() {
        let (_, _, root) = package_fixture("repair-0-9-16-patch");
        let home = root.join("home");
        let profile = home.join("profiles/web");
        std::fs::create_dir_all(&profile).expect("profile");
        let broken = "# profile patch\n[]\n\n- id: agent-preset-registry\n  config:\n    default: standard\n    selectedDefault: cordis\n";
        std::fs::write(profile.join("cordis.patch.yml"), broken).expect("broken patch");

        assert_eq!(migrate_legacy_profile_in(&home, &profile).unwrap(), 0);
        let repaired = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert!(!repaired.lines().any(|line| line == "[]"));
        assert_eq!(read_profile_default(&repaired).as_deref(), Some("cordis"));
        assert_eq!(
            std::fs::read_to_string(profile.join(PROFILE_PATCH_BACKUP)).unwrap(),
            broken
        );
        assert_eq!(migrate_legacy_profile_in(&home, &profile).unwrap(), 0);
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            repaired
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_presets_migrate_once_and_keep_their_source_and_profile_backup() {
        let (_, _, root) = package_fixture("legacy-migration");
        let home = root.join("home");
        let source = home.join(".agent-presets/custom");
        let profile = home.join("profiles/web");
        std::fs::create_dir_all(&source).expect("legacy preset");
        std::fs::create_dir_all(&profile).expect("profile");
        let composition = "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  disabled: !!js process.platform === 'win32'\n";
        std::fs::write(source.join(COMPOSITION), composition).expect("composition");
        std::fs::write(
            source.join(METADATA),
            "name: Custom mode\ndescription: Local mode\norder: 9\n",
        )
        .expect("metadata");
        std::fs::write(profile.join("cordis.patch.yml"), "[]\n").expect("profile patch");

        assert_eq!(migrate_legacy_profile_in(&home, &profile).unwrap(), 1);
        let migrated = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert!(migrated.contains(LEGACY_SECTION_START));
        assert!(migrated.contains("- id: preset-custom"));
        assert!(migrated.contains("id: custom"));
        assert!(migrated.contains("disabled: !!js process.platform === 'win32'"));
        assert!(migrated.contains("name: \"Custom mode\""));
        assert_eq!(
            std::fs::read_to_string(profile.join(PROFILE_PATCH_BACKUP)).unwrap(),
            "[]\n"
        );
        assert_eq!(
            std::fs::read_to_string(source.join(COMPOSITION)).unwrap(),
            composition
        );
        assert_eq!(migrate_legacy_profile_in(&home, &profile).unwrap(), 0);
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap(),
            migrated
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_legacy_builtin_default_migrates_without_a_custom_preset_directory() {
        let (_, _, root) = package_fixture("legacy-default");
        let home = root.join("home");
        let profile = home.join("profiles/web");
        std::fs::create_dir_all(&profile).expect("profile");
        std::fs::write(
            home.join("settings.yaml"),
            "agent-presets:\n  default: minimal\n",
        )
        .expect("legacy settings");
        std::fs::write(profile.join("cordis.patch.yml"), "[]\n").expect("profile patch");

        assert_eq!(migrate_legacy_profile_in(&home, &profile).unwrap(), 0);
        let patch = std::fs::read_to_string(profile.join("cordis.patch.yml")).unwrap();
        assert_eq!(read_profile_default(&patch).as_deref(), Some("minimal"));
        assert!(patch.contains("    default: standard"));
        assert_eq!(
            std::fs::read_to_string(profile.join(PROFILE_PATCH_BACKUP)).unwrap(),
            "[]\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn migration_skips_non_list_compositions_and_can_override_a_built_in() {
        assert!(valid_composition(
            "# mode\n- id: persona\n  name: package\n"
        ));
        assert!(!valid_composition("id: persona\nname: package\n"));
        let standard = migrated_preset_patch(
            "standard",
            "- id: persona\n  name: package\n",
            &Description::default(),
        );
        assert!(standard.starts_with("- id: preset-standard\n  config:"));
        assert!(!standard.contains("name: '@deepseek-ai/dsh-agent-preset'"));
    }

    #[test]
    fn modern_roster_scan_excludes_presets_the_profile_cannot_mount() {
        let (_, _, root) = package_fixture("modern-roster");
        let valid = root.join("valid");
        let broken = root.join("broken");
        std::fs::create_dir_all(&valid).expect("valid preset");
        std::fs::create_dir_all(&broken).expect("broken preset");
        std::fs::write(valid.join(COMPOSITION), "- id: persona\n  name: package\n")
            .expect("valid composition");
        std::fs::write(broken.join(COMPOSITION), "id: persona\nname: package\n")
            .expect("broken composition");

        let mut presets = Vec::new();
        scan(&root, false, true, &mut presets);
        assert_eq!(
            presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["valid"]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_portable_preset_is_verified_and_imported_atomically() {
        let (users, package, root) = package_fixture("round-trip");
        let source = users.join("team-code");
        std::fs::create_dir_all(source.join("instructions")).expect("preset directories");
        std::fs::write(source.join(COMPOSITION), "- name: agent\n").expect("composition");
        std::fs::write(
            source.join(METADATA),
            "name: Team Code\ndescription: Shared coding policy\norder: 9\n",
        )
        .expect("metadata");
        std::fs::write(source.join("instructions/system.md"), "Use the tests.\n")
            .expect("instruction");

        export_from(&users, "team-code", &package).expect("portable package");
        let inspected = inspect_package(&package).expect("verified package");
        assert_eq!(inspected.preview.id, "team-code");
        assert_eq!(inspected.preview.name.as_deref(), Some("Team Code"));
        assert_eq!(inspected.preview.files, 3);
        assert!(inspected.preview.integrity_verified);

        std::fs::remove_dir_all(&users).expect("simulate another machine");
        assert_eq!(
            import_into(&package, &users).expect("atomic import"),
            "team-code"
        );
        assert_eq!(
            std::fs::read_to_string(users.join("team-code/instructions/system.md")).unwrap(),
            "Use the tests.\n"
        );
        assert!(!std::fs::read_dir(&users)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(".importing-")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn importing_never_overwrites_an_existing_preset() {
        let (users, package, root) = package_fixture("collision");
        let source = users.join("team-code");
        std::fs::create_dir_all(&source).expect("preset directory");
        std::fs::write(source.join(COMPOSITION), "- name: original\n").expect("composition");
        export_from(&users, "team-code", &package).expect("portable package");

        let failure = import_into(&package, &users).expect_err("collision must stop");

        assert!(failure.to_string().contains("already exists"));
        assert_eq!(
            std::fs::read_to_string(source.join(COMPOSITION)).unwrap(),
            "- name: original\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn package_paths_cannot_escape_the_staging_directory() {
        for path in ["../settings.yaml", "/absolute", "nested\\windows", "./same"] {
            assert!(safe_relative(path).is_err(), "{path} must be rejected");
        }
        assert_eq!(
            safe_relative("instructions/system.md").unwrap(),
            PathBuf::from("instructions/system.md")
        );
    }
}

//! Which agent the harness starts new sessions as.
//!
//! The harness ships a handful of agent presets and picks between them with one
//! key — `agent-presets.default` in its settings document. That key is the whole
//! of this module's business with it, and the smallness is the point: a preset
//! directory carries a `preset.yml` whose only job is to give a picker a name and
//! a description, and the default is re-read for every session that starts, so
//! writing it while the harness is running changes the next session and leaves
//! the ones already open alone.
//!
//! Nothing here invents a layer. The presets are the harness's, the settings
//! document is the harness's, and the shell's part is to show what is there and
//! to change one scalar in a file somebody else formats. That is why the edit
//! below rewrites a line instead of parsing the document and serialising it back:
//! a round trip through a YAML library would reorder keys and drop comments, and
//! a diff nobody asked for is worse than a document this refuses to touch.

use std::path::{Path, PathBuf};

use serde::Serialize;

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

/// The presets the harness shipped, inside its own install.
fn shipped_root() -> PathBuf {
    paths::harness_dir()
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("config")
        .join("agent-presets")
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

    // Shipped first, which is also the precedence: the harness appends the user
    // root rather than prepending it, so a locally authored directory that
    // claimed a shipped id loses. Scanning in the same order with a
    // first-one-wins rule is the same answer, arrived at the same way.
    scan(&shipped_root(), true, &mut presets);
    scan(&user_root(), false, &mut presets);

    sort(&mut presets);

    Roster {
        presets,
        default: current_default(),
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
fn scan(root: &Path, shipped: bool, into: &mut Vec<Preset>) {
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
        if !directory.join(COMPOSITION).is_file() {
            continue;
        }

        let metadata = std::fs::read_to_string(directory.join(METADATA))
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
    read_default(&std::fs::read_to_string(settings_file()).ok()?)
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

    let path = settings_file();
    // A missing document is the first-run case, not a failure: the harness
    // creates it when it first needs to write something, and until then the
    // default is whatever its own configuration says.
    let document = std::fs::read_to_string(&path).unwrap_or_default();
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

#[cfg(test)]
mod tests {
    use super::*;

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
}

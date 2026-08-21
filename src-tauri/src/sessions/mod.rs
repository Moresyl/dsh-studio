//! Every session the harness has ever run on this machine, read back.
//!
//! The harness keeps each conversation as an append-only log under its own home,
//! one directory per project and one below that per session. It can index those
//! logs for search — the machinery ships with it — but the shipped configuration
//! points that index at an in-memory database it never opens, so nothing is
//! indexed and nothing older than the running session can be found again. Its
//! web UI has no address for a session either: there is no link that opens one.
//!
//! So a conversation from last week exists, in full, and is unreachable. Closing
//! that is work a shell is unusually well placed to do — reading every log on
//! the disk and folding it down is a background job with no interface, which is
//! exactly what a native process is for and exactly what a page cannot be asked
//! to do while somebody is waiting on it.
//!
//! Nothing here writes. The harness appends to these files while this app is
//! running, and a second writer on an append-only log is how a conversation gets
//! a hole in it.

pub mod artifact;
pub mod attention;
pub mod commands;
pub mod export;
pub mod find;
pub mod read;

use std::cmp::Reverse;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use serde::Serialize;

use crate::paths;

use find::Hit;

/// What the harness calls the directory it keeps sessions in.
const SESSIONS: &str = "sessions";

/// How much message text is kept in memory to search over.
///
/// A conversation with an agent is mostly tool output — files read, commands
/// run — so what is on disk outgrows what a person remembers saying by a wide
/// margin, and a year of them will not fit. Past this, the least recently wanted
/// session's text is dropped and read again next time it is asked for. Every
/// session stays listed, searchable and readable either way: the budget buys
/// speed, never coverage.
const CORPUS: u64 = 96 * 1024 * 1024;

/// Whose a line was.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// Typed by the person.
    User,
    /// Said by the model.
    Assistant,
    /// A tool being run, or answering.
    Tool,
    /// Material a plugin put in front of the model in the person's name.
    Context,
}

/// What a session spent.
///
/// Kept apart rather than summed because they are not the same money: cached
/// input is billed at a fraction of fresh input, and a session that looks
/// enormous by total is often a cheap one that re-read its own context.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    /// Input the provider charged for in full.
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Tokens {
    fn add(&mut self, other: &Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }

    /// Take back a sample that a later one replaced.
    fn undo(&mut self, other: &Tokens) {
        self.input = self.input.saturating_sub(other.input);
        self.output = self.output.saturating_sub(other.output);
        self.cache_read = self.cache_read.saturating_sub(other.cache_read);
        self.cache_write = self.cache_write.saturating_sub(other.cache_write);
    }
}

/// What one model was asked for, inside one session.
///
/// A session is rarely one model's work — a plan drafted by a reasoner and
/// carried out by a cheaper one is the usual shape, and the two are not billed
/// alike. A total that hides which of them did the spending cannot answer the
/// only question a bill is read for.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spend {
    /// Empty when the log never named one, which older logs sometimes do not.
    pub model: String,
    pub tokens: Tokens,
}

/// A session, as much of it as fits in a list.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    /// The directory it ran in, empty when the harness recorded none.
    pub project: String,
    pub started: i64,
    /// When the last thing in it happened.
    pub touched: i64,
    /// The opening of the first thing the person said, which is what a session
    /// is actually remembered by. The harness titles sessions with a model call
    /// and does not write the title down, so this is what is left — and it is
    /// the more honest of the two anyway.
    pub title: String,
    pub turns: u32,
    pub models: Vec<String>,
    pub tokens: Tokens,
    /// The same spend as `tokens`, split by which model did it. Always sums
    /// back to `tokens`, so a view built on either one agrees with the other.
    pub by_model: Vec<Spend>,
    /// Opened by an agent for its own work rather than by a person.
    pub delegated: bool,
    /// Size on disk, compressed as the harness stores it.
    pub bytes: u64,
}

/// One thing said, in the order it was said.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub seq: u64,
    pub time: i64,
    pub role: Role,
    /// What was run, on the lines that are a tool's doing.
    pub tool: Option<String>,
    pub text: String,
}

/// A session, whole.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub card: Card,
    pub lines: Vec<Line>,
}

/// What the library knows, and how much of it is worth keeping.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelved {
    pub cards: Vec<Card>,
    /// Sessions whose text is in memory right now, of the ones listed.
    pub loaded: usize,
}

/// Every session on the machine, kept read so it can be searched.
pub struct Library {
    /// Where the harness keeps them. Held rather than looked up per scan so a
    /// test can point a library at a store it built itself.
    root: PathBuf,
    shelves: Mutex<HashMap<PathBuf, Shelf>>,
    /// Ticks once per use, so the least recently wanted text is the text that
    /// goes when the corpus is full.
    clock: AtomicU64,
}

impl Default for Library {
    fn default() -> Library {
        Library::at(paths::dsh_home().join(SESSIONS))
    }
}

/// One session's place in the library.
struct Shelf {
    /// What the file looked like when it was read, so a session that has grown
    /// since is read again and one that has not is left alone.
    stamp: Stamp,
    card: Card,
    /// Dropped when the corpus fills up, and read again when next wanted.
    lines: Option<Vec<Line>>,
    /// Roughly what the text costs to hold.
    weight: u64,
    used: u64,
}

/// A file as it was, without opening it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct Stamp {
    bytes: u64,
    changed: Option<SystemTime>,
}

impl Stamp {
    fn of(path: &Path) -> Option<Stamp> {
        let facts = fs::metadata(path).ok()?;
        Some(Stamp {
            bytes: facts.len(),
            changed: facts.modified().ok(),
        })
    }
}

impl Library {
    /// A library over one session store.
    pub fn at(root: PathBuf) -> Library {
        Library {
            root,
            shelves: Mutex::default(),
            clock: AtomicU64::new(0),
        }
    }

    /// Every session, newest first.
    pub fn roster(&self) -> Shelved {
        self.refresh();

        let shelves = self.shelves();
        let mut cards: Vec<Card> = shelves.values().map(|shelf| shelf.card.clone()).collect();
        cards.sort_by_key(|card| Reverse(card.touched));

        Shelved {
            loaded: shelves
                .values()
                .filter(|shelf| shelf.lines.is_some())
                .count(),
            cards,
        }
    }

    /// The sessions a query describes, best answer first.
    pub fn search(&self, query: &str, project: Option<&str>) -> Vec<Hit> {
        let terms = find::terms(query);
        if terms.is_empty() {
            return Vec::new();
        }

        self.refresh();

        let paths: Vec<PathBuf> = {
            let shelves = self.shelves();
            shelves
                .iter()
                .filter(|(_, shelf)| project.is_none_or(|only| shelf.card.project == only))
                .map(|(path, _)| path.clone())
                .collect()
        };

        let mut hits: Vec<Hit> = paths
            .iter()
            .filter_map(|path| {
                let (card, lines) = self.body(path)?;
                find::hunt(&card, &lines, &terms)
            })
            .collect();

        find::rank(&mut hits);
        hits
    }

    /// The whole of one session, by the id the harness gave it.
    pub fn transcript(&self, id: &str) -> Option<Transcript> {
        self.refresh();

        let path = {
            let shelves = self.shelves();
            shelves
                .iter()
                .find(|(_, shelf)| shelf.card.id == id)
                .map(|(path, _)| path.clone())?
        };

        let (card, lines) = self.body(&path)?;
        Some(Transcript { card, lines })
    }

    /// One session's text, from memory if it is there and from disk if not.
    ///
    /// The read happens outside the lock. A session can be tens of megabytes,
    /// and holding every other reader off while one file is decompressed would
    /// make the first search after a cold start feel like a hang.
    fn body(&self, path: &Path) -> Option<(Card, Vec<Line>)> {
        let at = self.tick();

        {
            let mut shelves = self.shelves();
            if let Some(shelf) = shelves.get_mut(path) {
                if let Some(lines) = &shelf.lines {
                    shelf.used = at;
                    return Some((shelf.card.clone(), lines.clone()));
                }
            }
        }

        let stamp = Stamp::of(path)?;
        let reading = reread(path, stamp)?;
        let card = reading.card.clone();
        let lines = reading.lines.clone();

        let mut shelves = self.shelves();
        shelves.insert(path.to_path_buf(), Shelf::new(stamp, reading, at));
        self.trim(&mut shelves);

        Some((card, lines))
    }

    /// Bring the shelves in line with what is on the disk.
    ///
    /// Reading is done one session at a time with the lock released in between,
    /// so a first scan of a machine with a year of history neither blocks the
    /// sessions already read nor holds all of them in memory at once on the way
    /// to dropping most of them.
    fn refresh(&self) {
        let found = artifacts(&self.root);

        let stale: Vec<(PathBuf, Stamp)> = {
            let mut shelves = self.shelves();
            shelves.retain(|path, _| found.contains_key(path));
            found
                .iter()
                .filter(|(path, stamp)| {
                    shelves
                        .get(*path)
                        .is_none_or(|shelf| shelf.stamp != **stamp)
                })
                .map(|(path, stamp)| (path.clone(), *stamp))
                .collect()
        };

        for (path, stamp) in stale {
            let Some(reading) = reread(&path, stamp) else {
                continue;
            };
            let at = self.tick();
            let mut shelves = self.shelves();
            shelves.insert(path, Shelf::new(stamp, reading, at));
            self.trim(&mut shelves);
        }
    }

    /// Drop the text of the least recently wanted sessions until the rest fits.
    ///
    /// Their cards stay: a session whose text was dropped is still listed, still
    /// dated, still costed, and reading or searching it reads it again. Nothing
    /// about what the library can answer depends on what it happens to be
    /// holding — only on how quickly it answers.
    fn trim(&self, shelves: &mut HashMap<PathBuf, Shelf>) {
        let mut held: u64 = shelves.values().map(Shelf::held).sum();
        if held <= CORPUS {
            return;
        }

        let mut order: Vec<(u64, PathBuf)> = shelves
            .iter()
            .filter(|(_, shelf)| shelf.lines.is_some())
            .map(|(path, shelf)| (shelf.used, path.clone()))
            .collect();
        order.sort_by_key(|(used, _)| *used);

        for (_, path) in order {
            if held <= CORPUS {
                break;
            }
            let Some(shelf) = shelves.get_mut(&path) else {
                continue;
            };
            held = held.saturating_sub(shelf.held());
            shelf.lines = None;
        }
    }

    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed)
    }

    /// The shelves, whether or not a previous holder panicked.
    ///
    /// Nothing runs under this lock but map bookkeeping — every read, decode and
    /// parse happens with it released — so poisoning it would take a bug in
    /// `HashMap`. Refusing to serve on the off chance would hide that rather
    /// than report it.
    fn shelves(&self) -> MutexGuard<'_, HashMap<PathBuf, Shelf>> {
        self.shelves.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Shelf {
    fn new(stamp: Stamp, reading: read::Reading, at: u64) -> Shelf {
        Shelf {
            stamp,
            card: reading.card,
            weight: reading
                .lines
                .iter()
                .map(|line| line.text.len() as u64)
                .sum(),
            lines: Some(reading.lines),
            used: at,
        }
    }

    /// What this shelf costs the corpus right now.
    fn held(&self) -> u64 {
        if self.lines.is_some() {
            self.weight
        } else {
            0
        }
    }
}

/// Read one log, or nothing when it is unreadable or is not a session.
fn reread(path: &Path, stamp: Stamp) -> Option<read::Reading> {
    let text = artifact::text(path).ok()?;
    read::read(&text, stamp.bytes)
}

/// Every session log under a store, with what each looked like when found.
pub(super) fn artifacts(root: &Path) -> HashMap<PathBuf, Stamp> {
    let mut found = HashMap::new();

    for project in directories(root) {
        for session in directories(&project) {
            let Some(path) = artifact::locate(&session) else {
                continue;
            };
            let Some(stamp) = Stamp::of(&path) else {
                continue;
            };
            found.insert(path, stamp);
        }
    }

    found
}

/// The directories directly inside one, and none when there is no such one.
fn directories(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };

    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shelf(id: &str, text: &str, used: u64) -> Shelf {
        let line = Line {
            seq: 1,
            time: 1,
            role: Role::User,
            tool: None,
            text: text.to_string(),
        };
        Shelf {
            stamp: Stamp {
                bytes: 0,
                changed: None,
            },
            card: Card {
                id: id.into(),
                project: String::new(),
                started: 0,
                touched: 0,
                title: String::new(),
                turns: 0,
                models: Vec::new(),
                tokens: Tokens::default(),
                by_model: Vec::new(),
                delegated: false,
                bytes: 0,
            },
            weight: line.text.len() as u64,
            lines: Some(vec![line]),
            used,
        }
    }

    /// The point of the budget: what goes is what has been wanted least
    /// recently, and what stays is enough of it to be under the line.
    #[test]
    fn a_full_corpus_drops_the_coldest_text_first() {
        let library = Library::default();
        let mut shelves = HashMap::new();
        let big = "x".repeat(CORPUS as usize / 2 + 1);
        shelves.insert(PathBuf::from("cold"), shelf("cold", &big, 1));
        shelves.insert(PathBuf::from("warm"), shelf("warm", &big, 2));
        shelves.insert(PathBuf::from("hot"), shelf("hot", &big, 3));

        library.trim(&mut shelves);

        assert!(shelves[Path::new("cold")].lines.is_none());
        assert!(shelves[Path::new("hot")].lines.is_some());
        let held: u64 = shelves.values().map(Shelf::held).sum();
        assert!(held <= CORPUS, "{held}");
    }

    /// Dropping text must never drop the session. Everything the list shows and
    /// everything the totals count comes off the card, which stays.
    #[test]
    fn a_dropped_session_is_still_a_listed_session() {
        let library = Library::default();
        let mut shelves = HashMap::new();
        shelves.insert(
            PathBuf::from("cold"),
            shelf("cold", &"x".repeat(CORPUS as usize + 1), 1),
        );

        library.trim(&mut shelves);

        assert!(shelves[Path::new("cold")].lines.is_none());
        assert_eq!(shelves[Path::new("cold")].card.id, "cold");
    }

    #[test]
    fn a_corpus_that_fits_is_left_alone() {
        let library = Library::default();
        let mut shelves = HashMap::new();
        shelves.insert(PathBuf::from("one"), shelf("one", "small", 1));

        library.trim(&mut shelves);

        assert!(shelves[Path::new("one")].lines.is_some());
    }

    /// A step reported twice is subtracted before being re-added, and the
    /// subtraction must not be able to wrap a total below zero.
    #[test]
    fn undoing_more_than_was_counted_settles_at_nothing() {
        let mut tokens = Tokens {
            input: 5,
            ..Tokens::default()
        };
        tokens.undo(&Tokens {
            input: 99,
            ..Tokens::default()
        });

        assert_eq!(tokens.input, 0);
    }

    /// Nowhere to look is an empty library, not an error and not a panic — a
    /// machine that has never run the harness is a normal machine.
    #[test]
    fn nothing_to_read_is_read_as_nothing() {
        let library = Library::at(PathBuf::from("D:\\no\\such\\place\\at\\all"));

        assert!(library.roster().cards.is_empty());
        assert!(library.search("anything", None).is_empty());
        assert!(library.transcript("abc").is_none());
    }

    /// Build a session store the way the harness lays one out, compressed the
    /// way it compresses one: a frame for the header, then a frame per batch of
    /// events appended after it.
    fn store(purpose: &str, sessions: &[(&str, &str, &[&str])]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("dsh-studio-sessions-{purpose}"));
        let _ = fs::remove_dir_all(&root);

        for (project, id, rows) in sessions {
            let dir = root.join(project).join(id);
            fs::create_dir_all(&dir).expect("a session directory");

            let mut bytes = ruzstd::encoding::compress_to_vec(
                rows[0].as_bytes(),
                ruzstd::encoding::CompressionLevel::Fastest,
            );
            for row in &rows[1..] {
                bytes.extend(ruzstd::encoding::compress_to_vec(
                    row.as_bytes(),
                    ruzstd::encoding::CompressionLevel::Fastest,
                ));
            }

            fs::write(dir.join("session.jsonl.zstd"), bytes).expect("a session log");
        }

        root
    }

    /// The whole way through, over a store on disk in the harness's own format:
    /// found, decompressed, folded, listed, searched and opened.
    #[test]
    fn a_store_on_disk_is_listed_searched_and_opened() {
        let root = store(
            "roundtrip",
            &[
                (
                    "--D--work--",
                    "one",
                    &[
                        "{\"type\":\"session\",\"version\":0,\"id\":\"one\",\"createdAt\":1000,\"cwd\":\"D:\\\\work\"}\n",
                        "{\"type\":\"user/message\",\"seq\":1,\"time\":1100,\"data\":{\"source\":{\"kind\":\"user\"},\"content\":[{\"type\":\"text\",\"text\":\"移植 zstd 解析器\"}]}}\n{\"type\":\"assistant/chunk\",\"seq\":2,\"time\":1200,\"data\":{\"turn\":1,\"step\":0,\"chunk\":{\"type\":\"usage\",\"usage\":{\"inputTokens\":40,\"outputTokens\":9}}}}\n",
                    ],
                ),
                (
                    "--D--other--",
                    "two",
                    &[
                        "{\"type\":\"session\",\"version\":0,\"id\":\"two\",\"createdAt\":2000,\"cwd\":\"D:\\\\other\"}\n",
                        "{\"type\":\"user/message\",\"seq\":1,\"time\":2100,\"data\":{\"source\":{\"kind\":\"user\"},\"content\":[{\"type\":\"text\",\"text\":\"unrelated errand\"}]}}\n",
                    ],
                ),
            ],
        );

        let library = Library::at(root.clone());

        let shelved = library.roster();
        assert_eq!(shelved.cards.len(), 2);
        // Newest first, which is the order somebody looking for one wants them.
        assert_eq!(shelved.cards[0].id, "two");
        assert_eq!(shelved.cards[1].title, "移植 zstd 解析器");
        assert_eq!(shelved.cards[1].tokens.output, 9);
        assert_eq!(shelved.cards[1].turns, 1);

        let hits = library.search("解析器", None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].card.id, "one");
        assert_eq!(hits[0].marks[0].hit, "解析器");

        // Narrowing to a project is narrowing to a project, not to a word in one.
        assert!(library.search("errand", Some("D:\\work")).is_empty());
        assert_eq!(library.search("errand", Some("D:\\other")).len(), 1);

        let transcript = library.transcript("one").expect("a transcript");
        assert_eq!(transcript.card.project, "D:\\work");
        assert_eq!(transcript.lines[0].text, "移植 zstd 解析器");

        let _ = fs::remove_dir_all(&root);
    }

    /// A session grows while the app is open, and a library that answered from
    /// what it read an hour ago would be answering about a different session.
    #[test]
    fn a_session_that_grew_is_read_again() {
        let root = store(
            "regrow",
            &[(
                "--D--work--",
                "one",
                &["{\"type\":\"session\",\"version\":0,\"id\":\"one\",\"createdAt\":1000}\n"],
            )],
        );

        let library = Library::at(root.clone());
        assert!(library.search("afterwards", None).is_empty());

        let log = root
            .join("--D--work--")
            .join("one")
            .join("session.jsonl.zstd");
        let mut bytes = fs::read(&log).expect("the log");
        bytes.extend(ruzstd::encoding::compress_to_vec(
            "{\"type\":\"user/message\",\"seq\":1,\"time\":9000,\"data\":{\"source\":{\"kind\":\"user\"},\"content\":[{\"type\":\"text\",\"text\":\"said afterwards\"}]}}\n".as_bytes(),
            ruzstd::encoding::CompressionLevel::Fastest,
        ));
        fs::write(&log, bytes).expect("a longer log");

        let hits = library.search("afterwards", None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].card.touched, 9000);

        let _ = fs::remove_dir_all(&root);
    }
}

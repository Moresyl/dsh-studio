//! Finding a session again by something that was said in it.
//!
//! Matching is plain substring matching rather than word matching, because half
//! of what is worth searching for here is not a word: a path, a symbol, an error
//! code, a line of Chinese with no spaces in it. Splitting on word boundaries
//! would find none of them.
//!
//! A session answers a query when every term appears somewhere in it — not
//! necessarily in the same line, since the file you named and the error you got
//! are usually several messages apart. What comes back is the handful of lines
//! that matched, quoted with enough of their surroundings to recognise, so the
//! answer to "which session was that" can be read without opening any of them.

use serde::Serialize;

use super::{Card, Line, Role};

/// How many quoted lines one session contributes to a result.
///
/// Enough to see why it matched and to tell two similar sessions apart, few
/// enough that one enormous session cannot push the rest off the screen.
const MARKS: usize = 4;

/// How much of the line is kept on either side of what matched.
const MARGIN: usize = 72;

/// One session that answered, and why.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub card: Card,
    /// How many lines matched anything, which is how well it answered.
    pub matches: u32,
    pub marks: Vec<Mark>,
}

/// A line that matched, cut down to the part worth reading.
///
/// Split into three strings rather than sent as an offset because the two sides
/// of the bridge do not agree on what an offset is: Rust counts a string in
/// bytes and JavaScript counts it in UTF-16 code units, and every character
/// outside the Latin alphabet is where that disagreement shows up.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub seq: u64,
    pub time: i64,
    pub role: Role,
    pub tool: Option<String>,
    pub before: String,
    pub hit: String,
    pub after: String,
}

/// Break a query into the terms every answer has to contain.
pub fn terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();

    for word in query.split_whitespace() {
        let term = word.to_lowercase();
        // Lowercased first, so `Parse` and `parse` are the one term they read as.
        if !terms.contains(&term) {
            terms.push(term);
        }
    }

    terms
}

/// Whether a session answers, and with what, given already-lowercased terms.
pub fn hunt(card: &Card, lines: &[Line], terms: &[String]) -> Option<Hit> {
    if terms.is_empty() {
        return None;
    }

    // What a session is called and where it ran are as searchable as what was
    // said in it — "the one in dsh-studio" is how people remember sessions.
    let named = format!("{} {}", card.title, card.project);

    let mut answered = vec![false; terms.len()];
    let mut matches = 0;
    let mut marks = Vec::new();

    for (at, term) in terms.iter().enumerate() {
        if seek(&named, term).is_some() {
            answered[at] = true;
        }
    }

    for line in lines {
        let mut hit: Option<(usize, usize)> = None;

        for (at, term) in terms.iter().enumerate() {
            let Some(found) = seek(&line.text, term) else {
                continue;
            };
            answered[at] = true;
            // Quote from the earliest term that matched, so a line is shown from
            // the same place however the query happened to be ordered.
            if hit.is_none_or(|(was, _)| found.0 < was) {
                hit = Some(found);
            }
        }

        let Some((from, length)) = hit else { continue };

        matches += 1;
        if marks.len() < MARKS {
            marks.push(quote(line, from, length));
        }
    }

    // Every term, or none of it. A query is a description of one session, and
    // answering with the sessions that matched half of it is answering a
    // different question.
    answered.into_iter().all(|found| found).then(|| Hit {
        card: card.clone(),
        matches,
        marks,
    })
}

/// Order results the way somebody looking for a session would look through them.
///
/// Sessions that mention the terms more are better answers, and among sessions
/// that answer equally well the recent one is nearly always the one meant.
pub fn rank(hits: &mut [Hit]) {
    hits.sort_by(|left, right| {
        right
            .matches
            .cmp(&left.matches)
            .then(right.card.touched.cmp(&left.card.touched))
    });
}

/// Cut a matching line down to what is worth reading of it.
fn quote(line: &Line, from: usize, length: usize) -> Mark {
    let text = &line.text;
    let to = from.saturating_add(length).min(text.len());

    Mark {
        seq: line.seq,
        time: line.time,
        role: line.role,
        tool: line.tool.clone(),
        before: tail(&text[..from]),
        hit: text[from..to].to_string(),
        after: head(&text[to..]),
    }
}

/// The end of what came before, marked when there was more of it.
fn tail(text: &str) -> String {
    let text = text.replace('\n', " ");
    let over = text.chars().count().saturating_sub(MARGIN);
    if over == 0 {
        return text;
    }

    let mut kept = String::from("…");
    kept.extend(text.chars().skip(over));
    kept
}

/// The start of what came after, marked when there was more of it.
fn head(text: &str) -> String {
    let text = text.replace('\n', " ");
    let mut kept: String = text.chars().take(MARGIN).collect();
    if text.chars().nth(MARGIN).is_some() {
        kept.push('…');
    }
    kept
}

/// Where `needle` first appears in `haystack`, ignoring case, and how long it is.
///
/// Written out rather than lowercasing both sides first, because the haystack
/// here is the corpus: a query over every session on the machine would otherwise
/// allocate a second copy of every conversation on the machine to run.
///
/// `needle` is expected already lowercased — `terms` does that once per query
/// instead of once per line.
fn seek(haystack: &str, needle: &str) -> Option<(usize, usize)> {
    if needle.is_empty() {
        return None;
    }

    haystack
        .char_indices()
        .find_map(|(at, _)| prefix(&haystack[at..], needle).map(|length| (at, length)))
}

/// How many bytes of `text` its opening spends matching `needle`, if it does.
fn prefix(text: &str, needle: &str) -> Option<usize> {
    let mut wanted = needle.chars().peekable();
    let mut used = 0;

    for ch in text.chars() {
        if wanted.peek().is_none() {
            break;
        }
        // A character can lower-case into more than one, so the comparison runs
        // over what it becomes rather than over the character itself.
        for lower in ch.to_lowercase() {
            if wanted.next() != Some(lower) {
                return None;
            }
        }
        used += ch.len_utf8();
    }

    wanted.next().is_none().then_some(used)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card() -> Card {
        Card {
            id: "abc".into(),
            project: "D:\\GR\\dsh-studio".into(),
            started: 0,
            touched: 10,
            title: "port the parser".into(),
            turns: 1,
            models: Vec::new(),
            tokens: Default::default(),
            by_model: Vec::new(),
            delegated: false,
            bytes: 0,
        }
    }

    fn line(text: &str) -> Line {
        Line {
            seq: 1,
            time: 1,
            role: Role::User,
            tool: None,
            text: text.into(),
        }
    }

    #[test]
    fn a_query_is_lowercased_and_deduped() {
        assert_eq!(terms("  Parse  parse  PARSE  "), vec!["parse"]);
        assert_eq!(terms(""), Vec::<String>::new());
    }

    /// The terms of one query are spread across a conversation, not gathered in
    /// one line of it — that is what makes searching a session different from
    /// searching a file.
    #[test]
    fn every_term_has_to_appear_but_not_together() {
        let lines = [line("the parser panicked"), line("in frame.rs")];

        assert!(hunt(&card(), &lines, &terms("parser frame.rs")).is_some());
        assert!(hunt(&card(), &lines, &terms("parser missing")).is_none());
    }

    #[test]
    fn what_a_session_is_called_and_where_it_ran_are_searchable_too() {
        assert!(hunt(&card(), &[], &terms("dsh-studio")).is_some());
        assert!(hunt(&card(), &[], &terms("PORT")).is_some());
    }

    #[test]
    fn a_match_comes_back_quoted_in_three_pieces_that_rebuild_the_line() {
        let lines = [line("before the Needle and after")];
        let hit = hunt(&card(), &lines, &terms("needle")).expect("a hit");
        let mark = &hit.marks[0];

        // Case is preserved in what comes back even though it was ignored to
        // find it: the quote is the line, not the query.
        assert_eq!(mark.hit, "Needle");
        assert_eq!(
            format!("{}{}{}", mark.before, mark.hit, mark.after),
            "before the Needle and after"
        );
    }

    /// A tool result can be a whole file, and a hit in the middle of one is
    /// unreadable without cutting the rest away.
    #[test]
    fn a_hit_inside_a_long_line_is_cut_down_and_marked_on_both_sides() {
        let lines = [line(&format!(
            "{}needle{}",
            "x".repeat(500),
            "y".repeat(500)
        ))];
        let mark = &hunt(&card(), &lines, &terms("needle"))
            .expect("a hit")
            .marks[0];

        assert!(mark.before.starts_with('…'), "{}", mark.before);
        assert!(mark.after.ends_with('…'), "{}", mark.after);
        assert_eq!(mark.before.chars().count(), MARGIN + 1);
        assert_eq!(mark.after.chars().count(), MARGIN + 1);
    }

    /// Chinese has no spaces to split on and no case to fold, so a search that
    /// works by splitting words finds nothing in it. This one does not split.
    #[test]
    fn a_query_with_no_word_boundaries_still_finds_its_line() {
        let lines = [line("请把解析器移植过来")];

        assert!(hunt(&card(), &lines, &terms("解析器")).is_some());
        assert!(hunt(&card(), &lines, &terms("解析器 移植")).is_some());
        assert!(hunt(&card(), &lines, &terms("重构")).is_none());
    }

    #[test]
    fn only_the_first_few_lines_are_quoted_but_all_of_them_are_counted() {
        let lines: Vec<_> = (0..20).map(|_| line("needle")).collect();
        let hit = hunt(&card(), &lines, &terms("needle")).expect("a hit");

        assert_eq!(hit.matches, 20);
        assert_eq!(hit.marks.len(), MARKS);
    }

    #[test]
    fn the_session_that_mentions_it_most_comes_first_and_ties_go_to_the_recent() {
        let older = Card {
            touched: 1,
            ..card()
        };
        let newer = Card {
            touched: 99,
            ..card()
        };

        let mut hits = vec![
            Hit {
                card: older.clone(),
                matches: 2,
                marks: vec![],
            },
            Hit {
                card: newer.clone(),
                matches: 2,
                marks: vec![],
            },
            Hit {
                card: older,
                matches: 9,
                marks: vec![],
            },
        ];
        rank(&mut hits);

        assert_eq!(hits[0].matches, 9);
        assert_eq!(hits[1].card.touched, 99);
    }
}

//! A session, written out as a document somebody else can read.
//!
//! The harness keeps conversations in its own append-only format, in its own
//! directory, under an identifier nothing else knows. That is fine while the
//! conversation is the work — and useless the moment the work has to be shown to
//! anybody: pasted into an issue, quoted in a review, attached to a week's
//! summary. So the three formats here are chosen by where they are going rather
//! than by what is easy to emit.
//!
//!   - Markdown pastes into an issue tracker and stays readable if it does not.
//!   - HTML is a file to send to somebody who will open it and read it, once.
//!   - JSON is for whatever comes next, and is deliberately the same shape the
//!     application's own IPC uses rather than a second one invented here.
//!
//! Everything below is a pure function of a transcript. Nothing reads the disk,
//! nothing reads the clock, and the times that appear are UTC — an exported log
//! outlives the machine that made it, and a local time with no offset on it is
//! the reason half of them cannot be lined up with anything afterwards.

use serde::Deserialize;

use super::{Card, Role, Tokens, Transcript};

/// How long a suggested filename is allowed to get before the title is cut.
///
/// Short of any real limit, and deliberately: the name is a suggestion in a save
/// dialog, and one that fills the field is one the user has to clear first.
const NAME_CEILING: usize = 48;

/// What to write, chosen by where it is going.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Markdown,
    Html,
    Json,
}

impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Format::Markdown => "md",
            Format::Html => "html",
            Format::Json => "json",
        }
    }
}

/// The whole document.
pub fn render(transcript: &Transcript, format: Format) -> String {
    match format {
        Format::Markdown => markdown(transcript),
        Format::Html => html(transcript),
        // The IPC shape, pretty-printed. A second schema invented for export is
        // a second schema to keep in step with this one, and there is no reason
        // for the file on disk to disagree with what the pane was just showing.
        Format::Json => {
            serde_json::to_string_pretty(transcript).unwrap_or_else(|_| "{}".to_string())
        }
    }
}

/// A filename to offer, which the save dialog is free to have overridden.
///
/// Built from the title because that is what the session is remembered by, and
/// dated because a directory of exports sorts by name long before anybody
/// remembers which title was which.
pub fn suggest(card: &Card, format: Format) -> String {
    let (year, month, day) = civil(card.started.div_euclid(1000).div_euclid(86_400));
    let stem = slug(&card.title);
    let stem = if stem.is_empty() { "session" } else { &stem };

    format!(
        "{stem}-{year:04}-{month:02}-{day:02}.{}",
        format.extension()
    )
}

/// A title reduced to something every filesystem will accept.
///
/// Windows is the strict one and so sets the rules: a fixed set of forbidden
/// characters, no trailing dot or space, and a handful of names that are devices
/// rather than files no matter which directory they are in.
fn slug(title: &str) -> String {
    let mut out = String::new();
    let mut spaced = false;

    for character in title.chars() {
        // Control characters and the reserved punctuation both become the same
        // separator, so a title that was mostly punctuation collapses to one
        // hyphen rather than to a row of them.
        let keep = !character.is_control()
            && !matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '.'
            );

        if keep && !character.is_whitespace() {
            out.push(character);
            spaced = false;
        } else if !out.is_empty() && !spaced {
            out.push('-');
            spaced = true;
        }

        if out.chars().count() >= NAME_CEILING {
            break;
        }
    }

    let out = out.trim_matches('-').to_string();

    // `CON.md` is still the console on Windows, and a save dialog offering it
    // produces an error the user cannot make any sense of.
    const DEVICES: [&str; 6] = ["con", "prn", "aux", "nul", "com1", "lpt1"];
    if DEVICES.contains(&out.to_ascii_lowercase().as_str()) {
        return format!("{out}-session");
    }

    out
}

fn markdown(transcript: &Transcript) -> String {
    let card = &transcript.card;
    let mut out = String::new();

    out.push_str(&format!("# {}\n\n", oneline(&card.title)));
    out.push_str(&summary(card).join(" · "));
    out.push_str("\n\n");

    if card.tokens != Tokens::default() {
        out.push_str("| Model | Input | Output | Cache read | Cache write |\n");
        out.push_str("| --- | ---: | ---: | ---: | ---: |\n");
        for spend in &card.by_model {
            let model = if spend.model.is_empty() {
                "unnamed"
            } else {
                &spend.model
            };
            out.push_str(&format!("| {model} |{}\n", cells(&spend.tokens)));
        }
        out.push_str(&format!("| **Total** |{}\n\n", cells(&card.tokens)));
    }

    for line in &transcript.lines {
        out.push_str("---\n\n");
        out.push_str(&format!("**{}**", name(line.role)));
        if let Some(tool) = &line.tool {
            out.push_str(&format!(" · `{}`", oneline(tool)));
        }
        out.push_str(&format!(" · {}\n\n", clock(line.time)));

        // Tool output is not prose and does not survive being read as Markdown —
        // a shell's own asterisks and underscores would come back as emphasis.
        // Everything else is left alone: what the model wrote is already
        // Markdown, and wrapping it would throw away every heading and list.
        if line.role == Role::Tool {
            let rail = fence(&line.text);
            out.push_str(&format!("{rail}\n{}\n{rail}\n\n", line.text.trim_end()));
        } else {
            out.push_str(&format!("{}\n\n", line.text.trim_end()));
        }
    }

    out
}

/// A fence long enough to hold text that has fences of its own in it.
///
/// Tool output is very often somebody else's Markdown, and a three-backtick
/// fence around three-backtick content ends the block in the middle of it.
fn fence(text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for character in text.chars() {
        run = if character == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }

    "`".repeat(longest.max(2) + 1)
}

fn cells(tokens: &Tokens) -> String {
    format!(
        " {} | {} | {} | {} |",
        grouped(tokens.input),
        grouped(tokens.output),
        grouped(tokens.cache_read),
        grouped(tokens.cache_write),
    )
}

fn html(transcript: &Transcript) -> String {
    let card = &transcript.card;
    let mut out = String::new();

    // A whole document rather than a fragment, and one with its styling inside
    // it: this is a file that gets sent to somebody, and a file that needs a
    // stylesheet next to it arrives as plain text on the other end.
    out.push_str("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    out.push_str(&format!(
        "<title>{}</title>\n",
        escape(&oneline(&card.title))
    ));
    out.push_str(STYLE);
    out.push_str("</head>\n<body>\n<main>\n");

    out.push_str(&format!("<h1>{}</h1>\n", escape(&oneline(&card.title))));
    out.push_str(&format!(
        "<p class=\"meta\">{}</p>\n",
        summary(card)
            .iter()
            .map(|part| escape(part))
            .collect::<Vec<_>>()
            .join(" · ")
    ));

    for line in &transcript.lines {
        let role = match line.role {
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
            Role::Context => "context",
        };

        out.push_str(&format!(
            "<section class=\"line {role}\">\n<h2>{}",
            name(line.role)
        ));
        if let Some(tool) = &line.tool {
            out.push_str(&format!(" <code>{}</code>", escape(&oneline(tool))));
        }
        out.push_str(&format!(
            " <time>{}</time></h2>\n<pre>{}</pre>\n</section>\n",
            clock(line.time),
            escape(line.text.trim_end()),
        ));
    }

    out.push_str("</main>\n</body>\n</html>\n");
    out
}

/// The one stylesheet, kept small enough to read.
///
/// Both palettes, because an exported log is opened in whatever the reader has
/// their machine set to and a white page at midnight is its own small insult.
const STYLE: &str = r#"<style>
:root { --ground: #ffffff; --ink: #1a1c1e; --soft: #62676d; --edge: #e3e6ea; --sunk: #f5f6f8; --mark: #2f6feb; }
@media (prefers-color-scheme: dark) {
  :root { --ground: #16181b; --ink: #e6e8eb; --soft: #969ba1; --edge: #2a2e33; --sunk: #1d2024; --mark: #6ea8ff; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink);
  font: 15px/1.65 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 48px 24px 96px; }
h1 { font-size: 26px; line-height: 1.25; margin: 0 0 8px; letter-spacing: -0.015em; }
.meta { margin: 0 0 32px; color: var(--soft); font-size: 13px; }
.line { border-top: 1px solid var(--edge); padding: 20px 0; }
.line h2 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 10px;
  font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
.line time { margin-left: auto; color: var(--soft); font-weight: 400; letter-spacing: 0; }
.line code { font-size: 12px; font-weight: 400; letter-spacing: 0; color: var(--soft); }
.user h2 { color: var(--mark); }
.tool h2, .context h2 { color: var(--soft); }
pre { margin: 0; padding: 0; white-space: pre-wrap; overflow-wrap: anywhere;
  font: inherit; }
.tool pre, .context pre { background: var(--sunk); border: 1px solid var(--edge); border-radius: 6px;
  padding: 12px 14px; font: 12.5px/1.6 ui-monospace, "Cascadia Mono", Menlo, monospace; }
</style>
"#;

/// The header both readable formats carry, as parts to be joined.
fn summary(card: &Card) -> Vec<String> {
    let mut parts = Vec::new();

    if !card.project.is_empty() {
        parts.push(card.project.clone());
    }
    parts.push(format!("{} – {}", stamp(card.started), stamp(card.touched)));
    parts.push(format!(
        "{} turn{}",
        card.turns,
        if card.turns == 1 { "" } else { "s" }
    ));
    if !card.models.is_empty() {
        parts.push(card.models.join(", "));
    }
    if card.delegated {
        parts.push("delegated".to_string());
    }

    parts
}

fn name(role: Role) -> &'static str {
    match role {
        Role::User => "User",
        Role::Assistant => "Assistant",
        Role::Tool => "Tool",
        Role::Context => "Context",
    }
}

/// A heading is one line, whatever the thing it was made from was.
fn oneline(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(character),
        }
    }
    out
}

/// A count with thousands separators, because these are read and compared.
fn grouped(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);

    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }

    out
}

/// A moment, written so it means the same thing on every machine that reads it.
///
/// Public because the diagnostic report dates itself with it, and for the same
/// reason a session is dated with it: both are documents that leave this machine.
pub fn stamp(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let (year, month, day) = civil(seconds.div_euclid(86_400));
    let (hour, minute, second) = wall(seconds);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// The time of day alone, for the lines under a header that carries the date.
fn clock(millis: i64) -> String {
    let (hour, minute, second) = wall(millis.div_euclid(1000));
    format!("{hour:02}:{minute:02}:{second:02}")
}

fn wall(seconds: i64) -> (i64, i64, i64) {
    let day = seconds.rem_euclid(86_400);
    (day / 3600, (day % 3600) / 60, day % 60)
}

/// Split a count of days since 1970-01-01 into a UTC calendar date.
///
/// The shift moves the epoch to the start of a 400-year cycle that begins on a
/// March, which is what turns the leap-day rules into arithmetic: February is
/// then the last month of its year and its extra day falls at the end of the
/// cycle rather than in the middle of every calculation.
fn civil(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);

    // Months counted from March, so the twelfth is February and the leap day is
    // always the last day of the run.
    let month_of_year = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_of_year + 2) / 5 + 1) as u32;
    let month = if month_of_year < 10 {
        month_of_year + 3
    } else {
        month_of_year - 9
    } as u32;

    let year = year_of_era as i64 + era * 400;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{Line, Spend};

    /// Only for the tests, which need a line without writing out five fields.
    fn line(role: Role, tool: Option<&str>, text: &str) -> Line {
        Line {
            seq: 0,
            time: 1_755_000_000_000,
            role,
            tool: tool.map(str::to_string),
            text: text.to_string(),
        }
    }

    fn sample(title: &str, lines: Vec<Line>) -> Transcript {
        Transcript {
            card: Card {
                id: "01J".into(),
                project: "/work/app".into(),
                started: 1_755_000_000_000,
                touched: 1_755_003_600_000,
                title: title.to_string(),
                turns: lines.len() as u32,
                models: vec!["deepseek-chat".into()],
                tokens: Tokens {
                    input: 1234,
                    output: 56,
                    cache_read: 7,
                    cache_write: 0,
                },
                by_model: vec![Spend {
                    model: "deepseek-chat".into(),
                    tokens: Tokens {
                        input: 1234,
                        output: 56,
                        cache_read: 7,
                        cache_write: 0,
                    },
                }],
                delegated: false,
                bytes: 2048,
            },
            lines,
        }
    }

    #[test]
    fn the_epoch_and_the_days_around_it_land_on_the_right_dates() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(-1), (1969, 12, 31));
        // The leap day of a year divisible by 100 and by 400, which is the case
        // every wrong implementation of this gets wrong.
        assert_eq!(civil(11_016), (2000, 2, 29));
        // And a century that is not a leap year: 2100-02-28 is followed by March.
        assert_eq!(civil(47_540), (2100, 2, 28));
        assert_eq!(civil(47_541), (2100, 3, 1));
    }

    #[test]
    fn a_moment_is_written_in_utc_with_the_zone_on_it() {
        assert_eq!(stamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(stamp(1_755_000_000_000), "2025-08-12T12:00:00Z");
        // Before the epoch the seconds still have to count forwards through the
        // day rather than backwards from it.
        assert_eq!(stamp(-1), "1969-12-31T23:59:59Z");
        assert_eq!(clock(-1), "23:59:59");
    }

    #[test]
    fn counts_are_grouped_so_two_of_them_can_be_compared_by_eye() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000), "1,000");
        assert_eq!(grouped(1_234_567), "1,234,567");
    }

    #[test]
    fn a_fence_is_always_longer_than_anything_inside_it() {
        assert_eq!(fence("plain output"), "```");
        assert_eq!(fence("a ``` fence"), "````");
        assert_eq!(fence("````` deep"), "``````");
    }

    #[test]
    fn tool_output_that_is_itself_markdown_stays_inside_its_block() {
        let written = markdown(&sample(
            "Reproduce it",
            vec![line(Role::Tool, Some("Bash"), "```\nnpm ERR!\n```")],
        ));

        // The opening fence has to be longer than the ones in the output, or the
        // block ends on the first line of it and the rest becomes the document.
        assert!(written.contains("````\n```\nnpm ERR!\n```\n````"));
    }

    #[test]
    fn what_the_model_wrote_is_left_as_the_markdown_it_already_was() {
        let written = markdown(&sample(
            "Explain",
            vec![line(Role::Assistant, None, "## Heading\n\n- one\n- two")],
        ));

        assert!(written.contains("## Heading"));
        assert!(!written.contains("```"));
    }

    #[test]
    fn the_header_carries_what_somebody_reading_it_later_would_need() {
        let written = markdown(&sample("Fix the build", vec![line(Role::User, None, "hi")]));

        assert!(written.starts_with("# Fix the build\n"));
        assert!(written.contains("/work/app"));
        assert!(written.contains("2025-08-12T12:00:00Z – 2025-08-12T13:00:00Z"));
        assert!(written.contains("1 turn ·"));
        assert!(written.contains("| **Total** | 1,234 | 56 | 7 | 0 |"));
    }

    #[test]
    fn html_gets_out_of_everything_a_transcript_can_contain() {
        let written = html(&sample(
            "<script>alert(1)</script>",
            vec![line(Role::User, Some("a\"b"), "1 < 2 && 3 > 2")],
        ));

        assert!(written.contains("<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>"));
        assert!(written.contains("1 &lt; 2 &amp;&amp; 3 &gt; 2"));
        assert!(written.contains("<code>a&quot;b</code>"));
        // And nothing that got past the escaping is left executable.
        assert!(!written.contains("<script>"));
    }

    #[test]
    fn json_is_the_shape_the_application_already_speaks() {
        let transcript = sample("Anything", vec![line(Role::User, None, "hi")]);
        let written = render(&transcript, Format::Json);
        let read: serde_json::Value = serde_json::from_str(&written).expect("valid json");

        assert_eq!(read["card"]["title"], "Anything");
        assert_eq!(read["card"]["byModel"][0]["tokens"]["cacheRead"], 7);
        assert_eq!(read["lines"][0]["role"], "user");
    }

    #[test]
    fn a_suggested_name_is_one_every_filesystem_will_take() {
        let dated = |title: &str| {
            let mut transcript = sample(title, vec![]);
            transcript.card.title = title.to_string();
            suggest(&transcript.card, Format::Markdown)
        };

        assert_eq!(dated("Fix the build"), "Fix-the-build-2025-08-12.md");
        assert_eq!(dated("src/lib.rs: why?"), "src-lib-rs-why-2025-08-12.md");
        // A title made entirely of characters no filesystem takes still has to
        // produce a name, and one that is not just the date.
        assert_eq!(dated("///"), "session-2025-08-12.md");
        assert_eq!(dated(""), "session-2025-08-12.md");
        // Still the console, whatever extension is put after it.
        assert_eq!(dated("con"), "con-session-2025-08-12.md");
    }

    #[test]
    fn a_long_title_is_cut_rather_than_offered_whole() {
        let mut transcript = sample("", vec![]);
        transcript.card.title = "word ".repeat(40);
        let name = suggest(&transcript.card, Format::Html);

        assert!(name.len() <= NAME_CEILING + ".2025-08-12.html".len());
        assert!(name.ends_with("-2025-08-12.html"));
        assert!(!name.contains("--"));
    }

    #[test]
    fn every_format_puts_its_own_extension_on_the_file() {
        let card = sample("Report", vec![]).card;

        assert!(suggest(&card, Format::Markdown).ends_with(".md"));
        assert!(suggest(&card, Format::Html).ends_with(".html"));
        assert!(suggest(&card, Format::Json).ends_with(".json"));
    }
}

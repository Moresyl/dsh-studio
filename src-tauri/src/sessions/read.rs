//! A session log, folded down into what it was about and what was said.
//!
//! The log is an append-only record of everything the harness did, which is far
//! more than a conversation: request headers, streamed chunks, surface
//! operations, bookkeeping. What a person looking for an old session needs out
//! of that is much smaller — when it happened, what they asked, what came back,
//! and what it cost. This turns the one into the other.
//!
//! Two things are read the way the harness reads them rather than the way they
//! look, because the obvious reading is wrong in both cases:
//!
//!   - a message is only the person's if its source says so. Plugins write
//!     messages in the person's role to put material in front of the model, so
//!     counting by role alone would credit them with things they never typed;
//!   - usage is reported per turn and step, and a step is reported more than
//!     once as it grows. Adding the samples up would multiply the bill, so a
//!     repeat of a step replaces what it said before.

use std::collections::HashMap;

use serde_json::Value;

use super::{Card, Line, Role, Spend, Tokens};

/// How much of an opening line is kept as the name of a session.
const TITLE: usize = 96;

/// A log, read.
pub struct Reading {
    pub card: Card,
    pub lines: Vec<Line>,
}

/// Read a session log's JSONL text, or nothing when it is not one.
///
/// Every log the harness writes opens with a session header, so text without
/// one is either a file that is not a session or a session whose first frame
/// never landed. Neither is worth guessing at.
pub fn read(text: &str, bytes: u64) -> Option<Reading> {
    let mut rows = text.lines();
    let head: Value = serde_json::from_str(rows.next()?).ok()?;

    if str(head.get("type")) != "session" {
        return None;
    }

    let started = int(head.get("createdAt"));
    let explicit_surface = head.get("version").and_then(Value::as_u64).unwrap_or(0) >= 4;
    let mut card = Card {
        id: some(head.get("id"))?.to_string(),
        project: str(head.get("cwd")).to_string(),
        started,
        touched: started,
        title: String::new(),
        turns: 0,
        models: Vec::new(),
        tokens: Tokens::default(),
        by_model: Vec::new(),
        // Either mark is enough. A session an agent opened for itself has a
        // parent; one the harness spawned as a subagent says so; older logs
        // carry one and not always the other.
        delegated: head.get("parentSession").is_some() || str(head.get("origin")) == "subagent",
        bytes,
        limited: false,
    };

    let mut lines = Vec::new();
    let mut meter = Meter::default();
    // Which model the usage arriving now belongs to. A request header names it
    // before the answer starts and the answer names it again, so by the time
    // any usage is reported this is the model that earned it.
    let mut speaking = String::new();
    // Names the tool that produced each result. A result carries the id of the
    // call it answers but not what was called, and that name is the most useful
    // word on the line.
    let mut called: HashMap<String, String> = HashMap::new();

    for row in rows {
        let Ok(event) = serde_json::from_str::<Value>(row) else {
            continue;
        };

        let seq = event.get("seq").and_then(Value::as_u64).unwrap_or_default();
        let time = int(event.get("time"));
        card.touched = card.touched.max(time);

        let Some(data) = event.get("data") else {
            continue;
        };

        // Human history retains the original append-origin messages. A surface
        // replacement is a model-context copy, not another thing the user said.
        // Legacy logs may predate the explicit surface marker entirely.
        if matches!(
            str(event.get("type")),
            "user/message" | "assistant/message" | "tool/result"
        ) {
            let operation = event.get("surfaceOp");
            if (explicit_surface && str(operation) != "append")
                || operation
                    .and_then(|op| op.get("op"))
                    .and_then(Value::as_str)
                    == Some("replace")
            {
                continue;
            }
        }

        match str(event.get("type")) {
            // The event's data is the message itself here, unlike every other
            // kind, which wraps it.
            "user/message" => {
                let role = match str(source(data).and_then(|from| from.get("kind"))) {
                    // A tool answering is carried by `tool/result`; a message in
                    // the person's role from anything but the person is a
                    // plugin's doing, and saying otherwise would put words in
                    // their mouth.
                    "user" => Role::User,
                    _ => Role::Context,
                };

                let said = spoken(data);
                if role == Role::User {
                    card.turns += 1;
                    if card.title.is_empty() {
                        card.title = shorten(&said.text);
                        if card.title.is_empty() {
                            card.title = said
                                .attachments
                                .first()
                                .map(|item| shorten(item.label()))
                                .unwrap_or_default();
                        }
                    }
                }

                push(&mut lines, seq, time, role, None, said);
            }

            "assistant/message" => {
                let Some(message) = data.get("message") else {
                    continue;
                };

                if let Some(model) = some(source(message).and_then(|from| from.get("model"))) {
                    speaking = model.to_string();
                    note(&mut card.models, model);
                }

                push(
                    &mut lines,
                    seq,
                    time,
                    Role::Assistant,
                    None,
                    spoken(message),
                );

                for call in blocks(message).filter(|block| str(block.get("type")) == "tool-call") {
                    let name = str(call.get("name")).to_string();
                    if let Some(id) = some(call.get("id")) {
                        called.insert(id.to_string(), name.clone());
                    }
                    // The arguments arrive as raw JSON text, which is what a
                    // person searching for the file they had open is searching.
                    let arguments = str(call.get("arguments")).to_string();
                    push(
                        &mut lines,
                        seq,
                        time,
                        Role::Tool,
                        Some(name),
                        Content {
                            text: arguments,
                            ..Content::default()
                        },
                    );
                }

                if let Some(usage) = data.get("usage") {
                    let on = bill(&mut card.by_model, &speaking);
                    meter.sample(step(data), on, usage, &mut card.tokens, &mut card.by_model);
                }
            }

            "tool/result" => {
                let Some(message) = data.get("message") else {
                    continue;
                };

                // Current tool-role messages own their content directly. Older
                // logs wrapped the same content in nested tool-result blocks.
                if str(message.get("role")) == "tool" {
                    let call = some(message.get("toolCallId"))
                        .or_else(|| some(source(message).and_then(|value| value.get("callId"))));
                    let name = call.and_then(|id| called.get(id)).cloned();
                    push(&mut lines, seq, time, Role::Tool, name, spoken(message));
                }

                for block in blocks(message).filter(|block| str(block.get("type")) == "tool-result")
                {
                    let name = some(block.get("toolCallId"))
                        .and_then(|id| called.get(id))
                        .cloned();
                    push(&mut lines, seq, time, Role::Tool, name, said(block));
                }
            }

            "tool/call" => {
                if let (Some(id), Some(name)) = (some(data.get("callId")), some(data.get("name"))) {
                    called.insert(id.to_string(), name.to_string());
                }
            }

            // Usage arrives mid-answer as well as at the end of one, and for a
            // session that was interrupted it is the only place it arrives.
            "assistant/chunk" => {
                let Some(chunk) = data.get("chunk") else {
                    continue;
                };
                if str(chunk.get("type")) == "usage" {
                    if let Some(usage) = chunk.get("usage") {
                        let on = bill(&mut card.by_model, &speaking);
                        meter.sample(step(data), on, usage, &mut card.tokens, &mut card.by_model);
                    }
                }
            }

            // What was asked for, which is not always what answered — a request
            // that failed still names the model it was going to.
            "request/header" => {
                let config = data.get("header").and_then(|header| header.get("config"));
                if let Some(model) = some(config.and_then(|config| config.get("model"))) {
                    speaking = model.to_string();
                    note(&mut card.models, model);
                }
            }

            _ => {}
        }
    }

    if card.title.is_empty() {
        // A session with nothing typed in it is a real thing — an agent's own,
        // or one abandoned at the prompt. Naming it by what it ran beats naming
        // it by its id, which nobody recognises.
        card.title = lines
            .iter()
            .find(|line| !line.text.is_empty())
            .map(|line| shorten(&line.text))
            .unwrap_or_default();
    }

    Some(Reading { card, lines })
}

/// Fold usage samples the way the harness's own meter does.
///
/// A turn is answered in steps, and each step reports its usage repeatedly as it
/// runs, every report a running total rather than an increment. So a step that
/// is heard from twice replaces what it said the first time; a step heard from
/// once simply adds.
#[derive(Default)]
struct Meter {
    /// The last sample's step, the bill it went on, and what it contributed.
    last: Option<((u64, u64), usize, Tokens)>,
}

impl Meter {
    /// Take one usage report, on the session's total and on one model's share.
    ///
    /// The share is undone from wherever the replaced sample went rather than
    /// from wherever the current one is going: a step re-reported after the
    /// model changed would otherwise credit the new model with the old one's
    /// work, and leave the two views disagreeing.
    fn sample(
        &mut self,
        at: (u64, u64),
        on: usize,
        usage: &Value,
        into: &mut Tokens,
        bills: &mut [Spend],
    ) {
        let counted = Tokens {
            input: count(usage.get("inputTokens")),
            output: count(usage.get("outputTokens")),
            cache_read: count(usage.get("cacheReadTokens")),
            cache_write: count(usage.get("cacheWriteTokens")),
        };

        if let Some((was, whose, previously)) = self.last {
            if was == at {
                into.undo(&previously);
                if let Some(bill) = bills.get_mut(whose) {
                    bill.tokens.undo(&previously);
                }
            }
        }

        into.add(&counted);
        if let Some(bill) = bills.get_mut(on) {
            bill.tokens.add(&counted);
        }
        self.last = Some((at, on, counted));
    }
}

/// The bill a model's usage goes on, opened if this is the first of it.
fn bill(bills: &mut Vec<Spend>, model: &str) -> usize {
    if let Some(at) = bills.iter().position(|spend| spend.model == model) {
        return at;
    }
    bills.push(Spend {
        model: model.to_string(),
        tokens: Tokens::default(),
    });
    bills.len() - 1
}

/// Which turn and step a usage report belongs to.
fn step(data: &Value) -> (u64, u64) {
    (
        data.get("turn").and_then(Value::as_u64).unwrap_or_default(),
        data.get("step").and_then(Value::as_u64).unwrap_or_default(),
    )
}

/// Add a line, unless it would be a blank one.
#[derive(Default)]
struct Content {
    text: String,
    attachments: Vec<super::attachments::Attachment>,
    omitted: usize,
}

fn push(
    lines: &mut Vec<Line>,
    seq: u64,
    time: i64,
    role: Role,
    tool: Option<String>,
    content: Content,
) {
    if content.text.trim().is_empty() && content.attachments.is_empty() {
        return;
    }
    lines.push(Line {
        seq,
        time,
        role,
        tool,
        text: content.text,
        attachments: content.attachments,
        attachments_omitted: content.omitted,
    });
}

/// Everything a message said in words.
///
/// Reasoning is left out on purpose. It is the model thinking aloud, it is
/// several times the size of the answer it leads to, and nobody goes looking for
/// a session by what the model was weighing up on the way there.
fn spoken(message: &Value) -> Content {
    let mut text = String::new();

    for block in blocks(message).filter(|block| str(block.get("type")) == "text") {
        let part = str(block.get("text"));
        if part.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(part);
    }

    let (attachments, omitted) = super::attachments::collect(message);
    Content {
        text,
        attachments,
        omitted,
    }
}

/// What a tool answered, which is itself a little pile of blocks.
fn said(result: &Value) -> Content {
    spoken(result)
}

/// A message's content blocks, or none when it has none worth reading.
fn blocks(message: &Value) -> impl Iterator<Item = &Value> {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
}

/// Where a message came from, which is what decides whose it is.
fn source(message: &Value) -> Option<&Value> {
    message.get("source")
}

/// Remember a model, once, in the order it was first used.
fn note(models: &mut Vec<String>, model: &str) {
    if model.is_empty() || models.iter().any(|known| known == model) {
        return;
    }
    models.push(model.to_string());
}

/// The opening of a line, cut at a word where there is one to cut at.
fn shorten(text: &str) -> String {
    let opening = text.trim().lines().find(|line| !line.trim().is_empty());
    let Some(opening) = opening else {
        return String::new();
    };
    let opening = opening.trim();

    let mut kept = String::new();
    for (taken, ch) in opening.chars().enumerate() {
        if taken >= TITLE {
            // Back up to the last space, unless that would eat most of it —
            // languages that do not put spaces between words would lose the
            // whole title to that rule.
            if let Some(space) = kept.rfind(' ') {
                if space > TITLE / 2 {
                    kept.truncate(space);
                }
            }
            kept.push('…');
            break;
        }
        kept.push(ch);
    }

    kept
}

/// A string field, or the empty string when it is missing or is not one.
fn str(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or_default()
}

/// A string field that has to be there and has to say something.
fn some(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// A timestamp, in whichever of the two shapes a log carries it.
fn int(value: Option<&Value>) -> i64 {
    let Some(value) = value else { return 0 };
    if let Some(number) = value.as_i64() {
        return number;
    }
    // Milliseconds since the epoch survive a round trip through a double
    // intact for another quarter of a million years, so this loses nothing.
    value
        .as_f64()
        .map(|number| number as i64)
        .unwrap_or_default()
}

/// A token count, which is never negative and never fractional.
fn count(value: Option<&Value>) -> u64 {
    let Some(value) = value else { return 0 };
    value
        .as_u64()
        .or_else(|| value.as_f64().map(|number| number.max(0.0) as u64))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(rows: &[&str]) -> String {
        format!("{}\n", rows.join("\n"))
    }

    fn header() -> &'static str {
        r#"{"type":"session","version":0,"id":"abc","createdAt":1000,"cwd":"D:\\work"}"#
    }

    #[test]
    fn current_tool_messages_keep_direct_text_and_attachment_records() {
        use super::super::{export, find, Transcript};
        let text = log(&[
            &header().replace("\"version\":0", "\"version\":4"),
            r#"{"type":"tool/call","seq":1,"data":{"callId":"report","name":"write_report"}}"#,
            r#"{"type":"tool/result","seq":2,"surfaceOp":"append","data":{"message":{"role":"tool","toolCallId":"report","content":[{"type":"text","text":"Report ready"},{"type":"file","attachment":{"attachmentId":"sha256:abc","name":"报告.txt","bytes":12}}]}}}"#,
            r#"{"type":"tool/result","seq":3,"surfaceOp":"append","data":{"message":{"role":"tool","source":{"kind":"tool","callId":"report"},"content":[{"type":"image","attachment":{"attachmentId":"sha256:def","name":"图.png"}}]}}}"#,
        ]);
        let reading = read(&text, 0).unwrap();
        assert_eq!(reading.lines.len(), 2);
        assert_eq!(reading.lines[0].tool.as_deref(), Some("write_report"));
        assert_eq!(reading.lines[0].text, "Report ready");
        assert_eq!(reading.lines[1].tool.as_deref(), Some("write_report"));
        assert!(reading.lines[1].text.is_empty());
        let hit = find::hunt(&reading.card, &reading.lines, &find::terms("报告.txt")).unwrap();
        assert_eq!(hit.marks[0].seq, 2);
        let transcript = Transcript {
            card: reading.card,
            lines: reading.lines,
        };
        for format in [
            export::Format::Markdown,
            export::Format::Html,
            export::Format::Json,
        ] {
            let output = export::render(&transcript, format);
            assert!(
                output.contains("Report ready")
                    && output.contains("报告.txt")
                    && output.contains("图.png")
            );
        }
    }

    #[test]
    fn human_history_preserves_originals_and_omits_model_replacement_copies() {
        let text = log(&[
            &header().replace("\"version\":0", "\"version\":4"),
            r#"{"type":"user/message","seq":1,"surfaceOp":"append","data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Original prompt"}]}}"#,
            r#"{"type":"assistant/message","seq":2,"surfaceOp":"append","data":{"turn":1,"step":1,"message":{"content":[{"type":"text","text":"Original answer"}]},"usage":{"inputTokens":10,"outputTokens":5}}}"#,
            r#"{"type":"user/message","seq":3,"time":3000,"surfaceOp":{"op":"replace","startSeq":1,"endSeq":2},"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Model-only compacted copy"}]}}"#,
            r#"{"type":"assistant/message","seq":4,"surfaceOp":{"op":"replace","startSeq":3,"endSeq":3},"data":{"turn":2,"step":1,"message":{"content":[{"type":"text","text":"Model-only answer copy"}]},"usage":{"inputTokens":999,"outputTokens":999}}}"#,
            r#"{"type":"user/message","seq":5,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Unmarked v4 message"}]}}"#,
        ]);
        let reading = read(&text, 0).unwrap();
        assert_eq!(reading.card.turns, 1);
        assert_eq!(reading.card.title, "Original prompt");
        assert_eq!(reading.card.touched, 3000);
        assert_eq!(
            reading
                .lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["Original prompt", "Original answer"]
        );
        assert!(!reading.lines.iter().any(|line| line.seq >= 3));
        assert_eq!(reading.card.tokens.input, 10);
        assert_eq!(reading.card.tokens.output, 5);
    }

    #[test]
    fn legacy_messages_need_no_surface_marker_but_replacement_copies_stay_hidden() {
        let text = log(&[
            header(),
            r#"{"type":"user/message","seq":1,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Legacy original"}]}}"#,
            r#"{"type":"user/message","seq":2,"surfaceOp":{"op":"replace","startSeq":1,"endSeq":1},"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Replacement"}]}}"#,
            r#"{"type":"tool/call","seq":3,"data":{"callId":"missing-name"}}"#,
        ]);
        let reading = read(&text, 0).unwrap();
        assert_eq!(reading.card.turns, 1);
        assert_eq!(reading.lines.len(), 1);
        assert_eq!(reading.lines[0].text, "Legacy original");
    }

    #[test]
    fn attachment_only_messages_survive_reading_search_and_all_exports() {
        use super::super::{export, find, Transcript};
        let text = log(&[
            header(),
            r#"{"type":"user/message","seq":1,"time":1,"data":{"source":{"kind":"user"},"content":[{"type":"file","attachment":{"attachmentId":"sha256:abc","name":"C:\\private\\季度报告.txt","bytes":0}}]}}"#,
            r#"{"type":"assistant/message","seq":2,"time":2,"data":{"message":{"content":[{"type":"image","attachment":{"attachmentId":"sha256:def","name":"结果.png","mediaType":"image/png","bytes":12,"width":4,"height":3}}]}}}"#,
            r#"{"type":"tool/result","seq":3,"time":3,"data":{"message":{"content":[{"type":"tool-result","content":[{"type":"text","text":"generated"},{"type":"file","attachment":{"attachmentId":"ghi","name":"<img onerror=alert(1)>.txt","bytes":1}}]}]}}}"#,
        ]);
        let reading = read(&text, text.len() as u64).unwrap();
        assert_eq!(reading.card.title, "季度报告.txt");
        assert_eq!(reading.card.turns, 1);
        assert_eq!(reading.lines.len(), 3);
        assert!(reading.lines[0].text.is_empty());
        assert_eq!(reading.lines[1].role, Role::Assistant);
        assert_eq!(reading.lines[2].role, Role::Tool);
        assert_eq!(reading.lines[2].text, "generated");
        let hit = find::hunt(
            &reading.card,
            &reading.lines,
            &find::terms("generated onerror"),
        )
        .unwrap();
        assert_eq!(hit.marks[0].seq, 3);
        assert_eq!(hit.matches, 1);
        let image_hit =
            find::hunt(&reading.card, &reading.lines, &find::terms("结果.png")).unwrap();
        assert_eq!(image_hit.marks[0].seq, 2);
        let transcript = Transcript {
            card: reading.card,
            lines: reading.lines,
        };
        for format in [
            export::Format::Markdown,
            export::Format::Html,
            export::Format::Json,
        ] {
            let output = export::render(&transcript, format);
            assert!(output.contains("季度报告.txt"));
            assert!(output.contains("sha256:abc"));
            assert!(output.contains("结果.png"));
            assert!(!output.contains("private"));
            if format == export::Format::Html {
                assert!(!output.contains("<img onerror"));
                assert!(output.contains("&lt;img onerror"));
            }
        }
        assert!(transcript.lines[0].weight() > transcript.lines[0].text.len() as u64);
    }

    #[test]
    fn attachment_limits_remain_visible_in_exports() {
        use super::super::{export, Transcript};
        let event = serde_json::json!({"type":"user/message", "data": {
            "source":{"kind":"user"}, "content":vec![serde_json::json!({"type":"file"}); 66]
        }});
        let reading = read(&format!("{}\n{event}\n", header()), 0).unwrap();
        assert_eq!(reading.lines[0].attachments_omitted, 2);
        let transcript = Transcript {
            card: reading.card,
            lines: reading.lines,
        };
        for format in [export::Format::Markdown, export::Format::Html] {
            assert!(export::render(&transcript, format)
                .contains("2 additional attachment records omitted"));
        }
        let json: Value =
            serde_json::from_str(&export::render(&transcript, export::Format::Json)).unwrap();
        assert_eq!(json["lines"][0]["attachmentsOmitted"], 2);
        assert_eq!(
            json["lines"][0]["attachments"].as_array().unwrap().len(),
            64
        );
    }

    #[test]
    fn a_log_without_a_header_is_not_a_session() {
        assert!(read(&log(&[r#"{"type":"user/message","seq":1}"#]), 0).is_none());
        assert!(read("", 0).is_none());
    }

    #[test]
    fn the_header_names_the_session_and_the_events_date_it() {
        let reading = read(
            &log(&[
                header(),
                r#"{"type":"user/message","seq":1,"time":2000,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"hello"}]}}"#,
            ]),
            64,
        )
        .expect("a session");

        assert_eq!(reading.card.id, "abc");
        assert_eq!(reading.card.project, "D:\\work");
        assert_eq!(reading.card.started, 1000);
        assert_eq!(reading.card.touched, 2000);
        assert_eq!(reading.card.bytes, 64);
    }

    /// The distinction the whole history rests on: a plugin writes in the
    /// person's role, and showing that as something they said is a lie about
    /// their own conversation.
    #[test]
    fn only_what_the_person_typed_counts_as_theirs() {
        let reading = read(
            &log(&[
                header(),
                r#"{"type":"user/message","seq":1,"time":1,"data":{"source":{"kind":"plugin","form":"instructions"},"content":[{"type":"text","text":"remember the rules"}]}}"#,
                r#"{"type":"user/message","seq":2,"time":2,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"port the parser"}]}}"#,
            ]),
            0,
        )
        .expect("a session");

        assert_eq!(reading.card.turns, 1);
        assert_eq!(reading.card.title, "port the parser");
        assert_eq!(reading.lines[0].role, Role::Context);
        assert_eq!(reading.lines[1].role, Role::User);
    }

    /// Every report of a step is a running total, so adding them up would bill
    /// the same tokens as many times as the harness mentioned them.
    #[test]
    fn a_step_reported_twice_is_counted_once() {
        let reading = read(
            &log(&[
                header(),
                r#"{"type":"assistant/chunk","seq":1,"time":1,"data":{"turn":1,"step":0,"chunk":{"type":"usage","usage":{"inputTokens":10,"outputTokens":5}}}}"#,
                r#"{"type":"assistant/chunk","seq":2,"time":2,"data":{"turn":1,"step":0,"chunk":{"type":"usage","usage":{"inputTokens":10,"outputTokens":40}}}}"#,
                r#"{"type":"assistant/chunk","seq":3,"time":3,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":60,"outputTokens":7,"cacheReadTokens":100}}}}"#,
            ]),
            0,
        )
        .expect("a session");

        assert_eq!(reading.card.tokens.input, 70);
        assert_eq!(reading.card.tokens.output, 47);
        assert_eq!(reading.card.tokens.cache_read, 100);
    }

    /// A plan drafted by one model and carried out by another is the ordinary
    /// shape of a session, and the two are not billed at the same rate.
    #[test]
    fn each_model_is_billed_for_what_it_answered() {
        let reading = read(
            &log(&[
                header(),
                r#"{"type":"request/header","seq":1,"time":1,"data":{"header":{"config":{"model":"deepseek-reasoner"}}}}"#,
                r#"{"type":"assistant/chunk","seq":2,"time":2,"data":{"turn":1,"step":0,"chunk":{"type":"usage","usage":{"inputTokens":100,"outputTokens":20}}}}"#,
                r#"{"type":"request/header","seq":3,"time":3,"data":{"header":{"config":{"model":"deepseek-chat"}}}}"#,
                r#"{"type":"assistant/chunk","seq":4,"time":4,"data":{"turn":2,"step":0,"chunk":{"type":"usage","usage":{"inputTokens":7,"outputTokens":3}}}}"#,
            ]),
            0,
        )
        .expect("a session");

        assert_eq!(
            reading.card.by_model,
            vec![
                Spend {
                    model: "deepseek-reasoner".into(),
                    tokens: Tokens {
                        input: 100,
                        output: 20,
                        ..Tokens::default()
                    },
                },
                Spend {
                    model: "deepseek-chat".into(),
                    tokens: Tokens {
                        input: 7,
                        output: 3,
                        ..Tokens::default()
                    },
                },
            ]
        );
    }

    /// The split has to reconcile with the total under the same rule the total
    /// follows, and a step re-reported after a switch is where it would not.
    #[test]
    fn a_replaced_sample_is_taken_off_the_bill_it_went_on() {
        let reading = read(
            &log(&[
                header(),
                r#"{"type":"request/header","seq":1,"time":1,"data":{"header":{"config":{"model":"deepseek-reasoner"}}}}"#,
                r#"{"type":"assistant/chunk","seq":2,"time":2,"data":{"turn":1,"step":0,"chunk":{"type":"usage","usage":{"inputTokens":10,"outputTokens":5}}}}"#,
                r#"{"type":"request/header","seq":3,"time":3,"data":{"header":{"config":{"model":"deepseek-chat"}}}}"#,
                r#"{"type":"assistant/chunk","seq":4,"time":4,"data":{"turn":1,"step":0,"chunk":{"type":"usage","usage":{"inputTokens":10,"outputTokens":40}}}}"#,
            ]),
            0,
        )
        .expect("a session");

        let summed = reading
            .card
            .by_model
            .iter()
            .fold(Tokens::default(), |mut total, spend| {
                total.add(&spend.tokens);
                total
            });

        assert_eq!(summed, reading.card.tokens);
        assert_eq!(reading.card.by_model[0].tokens, Tokens::default());
        assert_eq!(reading.card.by_model[1].tokens.output, 40);
    }

    #[test]
    fn a_tool_result_is_named_by_the_call_it_answers() {
        let reading = read(
            &log(&[
                header(),
                r#"{"type":"assistant/message","seq":1,"time":1,"data":{"turn":1,"step":0,"message":{"source":{"kind":"model","model":"deepseek-chat"},"content":[{"type":"text","text":"looking"},{"type":"tool-call","id":"c1","name":"Grep","arguments":"{\"pattern\":\"parse\"}"}]}}}"#,
                r#"{"type":"tool/result","seq":2,"time":2,"data":{"message":{"role":"tool","source":{"kind":"tool"},"content":[{"type":"tool-result","toolCallId":"c1","content":[{"type":"text","text":"3 matches"}]}]}}}"#,
            ]),
            0,
        )
        .expect("a session");

        assert_eq!(reading.card.models, vec!["deepseek-chat"]);

        let named: Vec<_> = reading
            .lines
            .iter()
            .filter(|line| line.role == Role::Tool)
            .map(|line| (line.tool.as_deref(), line.text.as_str()))
            .collect();
        assert_eq!(
            named,
            vec![
                (Some("Grep"), "{\"pattern\":\"parse\"}"),
                (Some("Grep"), "3 matches"),
            ]
        );
    }

    /// A log is appended to while it is being read, so its last line is as
    /// likely as not to be half of one. It costs that line and nothing else.
    #[test]
    fn a_torn_last_row_costs_only_itself() {
        let reading = read(
            &format!(
                "{}\n{}\n{{\"type\":\"user/mess",
                header(),
                r#"{"type":"user/message","seq":1,"time":1,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"first"}]}}"#
            ),
            0,
        )
        .expect("a session");

        assert_eq!(reading.card.turns, 1);
        assert_eq!(reading.lines.len(), 1);
    }

    #[test]
    fn a_long_opening_is_cut_at_a_word_and_marked() {
        let long = "the quick brown fox jumps over the lazy dog ".repeat(6);
        let title = shorten(&long);

        assert!(title.ends_with('…'), "{title}");
        assert!(title.chars().count() <= TITLE + 1, "{title}");
        assert!(title.starts_with("the quick brown fox"), "{title}");
    }

    /// Nothing to cut at is still a title. Chinese does not space its words,
    /// and a rule written for English must not leave those sessions nameless.
    #[test]
    fn an_opening_with_no_spaces_keeps_its_length() {
        let title = shorten(&"会话".repeat(80));

        assert!(title.ends_with('…'), "{title}");
        assert_eq!(title.chars().count(), TITLE + 1);
    }
}

//! Privacy-safe native attention from durable session events.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Manager, UserAttentionType};

use super::{artifact, artifacts, Stamp};

const POLL: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Completed,
    Failed,
}

impl Outcome {
    fn enabled(self) -> bool {
        let attention = match self {
            Outcome::Completed => crate::startup::Attention::TurnCompleted,
            Outcome::Failed => crate::startup::Attention::TurnFailed,
        };
        crate::startup::attention_enabled(attention)
    }
}

struct Observer {
    root: PathBuf,
    since: i64,
    seen: HashMap<PathBuf, (Stamp, u64)>,
}

impl Observer {
    fn managed() -> Self {
        Self {
            root: crate::paths::dsh_home().join("sessions"),
            since: now(),
            seen: HashMap::new(),
        }
    }

    fn scan(&mut self) -> Vec<Outcome> {
        let found = artifacts(&self.root);
        self.seen.retain(|path, _| found.contains_key(path));
        let mut outcomes = Vec::new();

        for (path, stamp) in found {
            let previous = self.seen.get(&path).copied();
            if previous.is_some_and(|(old, _)| old == stamp) {
                continue;
            }
            let Some(text) = artifact::text(&path).ok() else {
                continue;
            };
            let after = previous.map(|(_, seq)| seq).unwrap_or_default();
            let (latest, fresh) = parse(&text, after, self.since);
            self.seen.insert(path, (stamp, latest));
            outcomes.extend(fresh);
        }
        outcomes
    }
}

/// Start polling off the async workers; decompression may read a large log.
pub fn wire(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut observer = Observer::managed();
        loop {
            tokio::time::sleep(POLL).await;
            let scanned = tauri::async_runtime::spawn_blocking(move || {
                let outcomes = observer.scan();
                (observer, outcomes)
            })
            .await;
            let Ok((next, outcomes)) = scanned else {
                break;
            };
            observer = next;

            if outcomes.is_empty() || focused(&handle) {
                continue;
            }
            for outcome in outcomes {
                if !outcome.enabled() {
                    continue;
                }
                let (title, body) = copy(outcome);
                let _ = crate::desktop::notify(&handle, title, body);
                if let Some(window) = crate::window::front(&handle) {
                    let _ = window.request_user_attention(Some(UserAttentionType::Informational));
                }
            }
        }
    });
}

fn focused(app: &AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false))
}

fn copy(outcome: Outcome) -> (&'static str, &'static str) {
    match outcome {
        Outcome::Completed => (
            crate::locale::pick("Turn completed", "用户回合已完成"),
            crate::locale::pick(
                "A direct user turn has finished.",
                "有一个用户发起的回合已经结束。",
            ),
        ),
        Outcome::Failed => (
            crate::locale::pick("Turn needs attention", "用户回合需要处理"),
            crate::locale::pick(
                "A direct user turn failed or reached its token limit.",
                "有一个用户发起的回合失败或达到令牌上限。",
            ),
        ),
    }
}

fn parse(text: &str, after: u64, since: i64) -> (u64, Vec<Outcome>) {
    let mut rows = text.lines();
    let Some(header) = rows
        .next()
        .and_then(|row| serde_json::from_str::<Value>(row).ok())
    else {
        return (after, Vec::new());
    };
    if string(header.get("type")) != "session" || string(header.get("origin")) == "subagent" {
        return (after, Vec::new());
    }

    let mut latest = after;
    let mut open: Option<(u64, bool)> = None;
    let mut outcomes = Vec::new();
    for row in rows {
        let Ok(event) = serde_json::from_str::<Value>(row) else {
            continue;
        };
        let seq = event.get("seq").and_then(Value::as_u64).unwrap_or_default();
        latest = latest.max(seq);
        let data = event.get("data").unwrap_or(&Value::Null);
        match string(event.get("type")) {
            "turn/start" => {
                open = Some((number(data.get("turn")), false));
            }
            "user/message" => {
                if string(data.pointer("/source/kind")) == "user" {
                    if let Some((_, initiated)) = open.as_mut() {
                        *initiated = true;
                    }
                }
            }
            "turn/end" => {
                let turn = number(data.get("turn"));
                let initiated = open
                    .take()
                    .is_some_and(|(current, initiated)| current == turn && initiated);
                let time = event
                    .get("time")
                    .and_then(Value::as_i64)
                    .unwrap_or_default();
                if !initiated || seq <= after || time < since {
                    continue;
                }
                match string(data.pointer("/reason/kind")) {
                    "completed" => outcomes.push(Outcome::Completed),
                    "error" | "max-tokens" => outcomes.push(Outcome::Failed),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    (latest, outcomes)
}

fn string(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or_default()
}

fn number(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or_default()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{parse, Outcome};

    fn log(origin: &str, rows: &[&str]) -> String {
        format!(
            "{{\"type\":\"session\",\"id\":\"one\",\"origin\":\"{origin}\"}}\n{}",
            rows.join("\n")
        )
    }

    #[test]
    fn only_a_new_direct_user_turn_requests_attention() {
        let text = log(
            "user",
            &[
                r#"{"type":"turn/start","seq":1,"time":100,"data":{"turn":1}}"#,
                r#"{"type":"user/message","seq":2,"time":101,"data":{"source":{"kind":"user"}}}"#,
                r#"{"type":"turn/end","seq":3,"time":102,"data":{"turn":1,"reason":{"kind":"completed"}}}"#,
            ],
        );
        assert_eq!(parse(&text, 2, 0).1, [Outcome::Completed]);
        assert!(parse(&text, 3, 0).1.is_empty());
    }

    #[test]
    fn failures_notify_but_cancellation_and_plugin_turns_do_not() {
        let text = log(
            "user",
            &[
                r#"{"type":"turn/start","seq":1,"time":100,"data":{"turn":1}}"#,
                r#"{"type":"user/message","seq":2,"time":101,"data":{"source":{"kind":"plugin"}}}"#,
                r#"{"type":"turn/end","seq":3,"time":102,"data":{"turn":1,"reason":{"kind":"error"}}}"#,
                r#"{"type":"turn/start","seq":4,"time":103,"data":{"turn":2}}"#,
                r#"{"type":"user/message","seq":5,"time":104,"data":{"source":{"kind":"user"}}}"#,
                r#"{"type":"turn/end","seq":6,"time":105,"data":{"turn":2,"reason":{"kind":"aborted"}}}"#,
                r#"{"type":"turn/start","seq":7,"time":106,"data":{"turn":3}}"#,
                r#"{"type":"user/message","seq":8,"time":107,"data":{"source":{"kind":"user"}}}"#,
                r#"{"type":"turn/end","seq":9,"time":108,"data":{"turn":3,"reason":{"kind":"max-tokens"}}}"#,
            ],
        );
        assert_eq!(parse(&text, 0, 0).1, [Outcome::Failed]);
    }

    #[test]
    fn subagents_and_events_from_before_this_app_launch_stay_silent() {
        let rows = [
            r#"{"type":"turn/start","seq":1,"time":100,"data":{"turn":1}}"#,
            r#"{"type":"user/message","seq":2,"time":101,"data":{"source":{"kind":"user"}}}"#,
            r#"{"type":"turn/end","seq":3,"time":102,"data":{"turn":1,"reason":{"kind":"completed"}}}"#,
        ];
        assert!(parse(&log("subagent", &rows), 0, 0).1.is_empty());
        assert!(parse(&log("user", &rows), 0, 103).1.is_empty());
    }
}

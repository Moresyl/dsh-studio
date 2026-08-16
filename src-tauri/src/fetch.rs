//! Fetch a URL through the Node runtime the shell already found.
//!
//! Everything the shell reads from the wider internet — the package registry,
//! the release feed — is HTTPS, and an HTTPS client is a large dependency to
//! take on for a handful of GET requests. The machine already has one: the Node
//! this app located in order to run the harness at all, whose `fetch` has been
//! global since Node 18.
//!
//! Borrowing it buys more than a smaller binary. Node reads the user's proxy
//! environment and their certificate store, so a shell behind a corporate proxy
//! or pointed at a mirror registry works for exactly the same reason `npm`
//! does, without this file knowing either of those things exist.
//!
//! The URL is passed as an argument rather than pasted into the script, so a
//! string arriving from a search result cannot become code. Nothing here goes
//! through a shell.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::error::{Error, Result};

/// Read the whole body, then exit. Non-2xx is a failure with the status in it,
/// because a registry that answers 404 has told us something the caller needs
/// to distinguish from a network that is down.
const SCRIPT: &str = r#"
const url = process.argv[1]
const timeout = AbortSignal.timeout(Number(process.argv[2]))
fetch(url, { signal: timeout, headers: { 'user-agent': 'dsh-studio', accept: 'application/json' } })
  .then(async (response) => {
    if (!response.ok) {
      process.stderr.write(`HTTP ${response.status} ${response.statusText}`)
      process.exit(1)
    }
    process.stdout.write(await response.text())
  })
  .catch((cause) => {
    process.stderr.write(String((cause && cause.message) || cause))
    process.exit(1)
  })
"#;

/// GET `url` and parse the reply as JSON.
///
/// `budget` bounds the request inside Node and the process outside it, so a
/// runtime that hangs before it ever reaches `fetch` cannot strand the caller.
pub async fn json(node: &Path, url: &str, budget: Duration) -> Result<serde_json::Value> {
    let body = text(node, url, budget).await?;
    serde_json::from_str(&body)
        .map_err(|cause| Error::Network(format!("unreadable reply: {cause}")))
}

/// GET `url` and return the body as it arrived.
pub async fn text(node: &Path, url: &str, budget: Duration) -> Result<String> {
    let mut command = Command::new(node);
    command
        .arg("-e")
        .arg(SCRIPT)
        .arg(url)
        .arg(budget.as_millis().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // A console window flashing up behind a search box would be its own bug
        // report. CREATE_NO_WINDOW, spelled out to avoid a winapi dependency
        // for one constant.
        command.creation_flags(0x0800_0000);
    }

    // Node's own timeout is the real bound; this one only covers a runtime that
    // never gets as far as running the script.
    let output = tokio::time::timeout(budget + Duration::from_secs(5), command.output())
        .await
        .map_err(|_| Error::Network(format!("{url} did not answer in time")))?
        .map_err(|cause| {
            Error::Network(format!("could not run Node to reach the network: {cause}"))
        })?;

    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::Network(if reason.is_empty() {
            format!("{url} could not be reached")
        } else {
            reason
        }));
    }

    String::from_utf8(output.stdout)
        .map_err(|cause| Error::Network(format!("reply was not text: {cause}")))
}

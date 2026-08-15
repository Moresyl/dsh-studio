//! Ask the harness whether it is still answering, not merely still running.
//!
//! Watching the process handle catches a crash and nothing else. The failure
//! that actually strands a user is the quieter one: the process is alive, the
//! socket is open, and requests go unanswered — a wedged event loop, a plugin
//! deadlocked on a lock it will never get. A shell that only watches for exit
//! reports "ready" through all of it.
//!
//! So the probe speaks HTTP. A TCP connect proves nothing here, because the
//! kernel completes the handshake from the listen backlog whether or not the
//! process ever calls `accept` again; only a reply proves the process is still
//! servicing requests. That is a request and a status line, on loopback, with
//! no TLS — small enough to write directly rather than take an HTTP client for.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Shortest possible HTTP status line, `HTTP/1.1 200`.
const STATUS_LINE_PREFIX: usize = 12;

/// Check that `origin` still answers, within `budget`.
///
/// Any status counts as healthy — even 404. The question is whether the process
/// is still serving, not what it thinks of the path.
pub async fn probe(origin: &str, budget: Duration) -> Result<(), String> {
    tokio::time::timeout(budget, exchange(origin))
        .await
        .map_err(|_| format!("no reply within {}s", budget.as_secs()))?
}

async fn exchange(origin: &str) -> Result<(), String> {
    let url = url::Url::parse(origin).map_err(|cause| format!("unusable origin: {cause}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "origin has no host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "origin has no port".to_string())?;

    let mut socket = TcpStream::connect((host, port))
        .await
        .map_err(|cause| format!("connect refused: {cause}"))?;

    // HEAD keeps the reply to a header block, and `Connection: close` means the
    // server hangs up when it is done — so nothing here has to understand
    // chunked encoding or content lengths to know the exchange completed.
    let request = format!(
        "HEAD / HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nUser-Agent: dsh-studio\r\n\r\n"
    );
    socket
        .write_all(request.as_bytes())
        .await
        .map_err(|cause| format!("request failed: {cause}"))?;

    let mut opening = [0u8; STATUS_LINE_PREFIX];
    socket
        .read_exact(&mut opening)
        .await
        .map_err(|cause| format!("no status line: {cause}"))?;

    if opening.starts_with(b"HTTP/") {
        Ok(())
    } else {
        Err(format!(
            "reply was not HTTP: {}",
            String::from_utf8_lossy(&opening).escape_debug()
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    use super::probe;

    /// Serve one reply, then hand back the origin it was served on.
    async fn serving(reply: &'static [u8]) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let _ = socket.write_all(reply).await;
                let _ = socket.shutdown().await;
            }
        });
        origin
    }

    #[tokio::test]
    async fn accepts_any_status_a_live_server_returns() {
        let origin = serving(b"HTTP/1.1 404 Not Found\r\n\r\n").await;
        assert!(probe(&origin, Duration::from_secs(2)).await.is_ok());
    }

    #[tokio::test]
    async fn rejects_a_reply_that_is_not_http() {
        let origin = serving(b"SSH-2.0-OpenSSH_9.6\r\n").await;
        assert!(probe(&origin, Duration::from_secs(2)).await.is_err());
    }

    #[tokio::test]
    async fn fails_when_nothing_is_listening() {
        // Bind and drop, so the port is real but certainly closed.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("addr"));
        drop(listener);

        assert!(probe(&origin, Duration::from_secs(2)).await.is_err());
    }

    /// The case the whole module exists for: the port accepts, nobody replies.
    #[tokio::test]
    async fn times_out_against_a_listener_that_never_answers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("addr"));
        // Held, never accepted from — the kernel still completes the handshake.
        let _held = listener;

        assert!(probe(&origin, Duration::from_millis(300)).await.is_err());
    }
}

//! The door: an authenticated TCP relay from the local network to a service
//! that is still bound to loopback.
//!
//! The harness never learns any of this exists. It keeps its kernel-assigned
//! port on `127.0.0.1`, and this listener — started only when a person asks for
//! it — is the single place where a packet from another device can turn into a
//! packet to that port. One session token, generated per start and never
//! written to disk, is what separates the two.
//!
//! Why a byte relay rather than an HTTP proxy: the harness speaks HTTP, then
//! server-sent events, then WebSocket over the same connections, and a relay
//! that stops parsing after the first header block carries all three without
//! having to understand any of them. The parsing that does happen is exactly
//! what the decision needs — the request line and two headers — and the bytes
//! that were read to get there are forwarded along with everything after.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

/// Cookie the browser gets after pairing, and presents on every later request.
const COOKIE: &str = "dsh_studio_remote";

/// Query parameter carrying the token in the paired URL.
const PAIR_PARAM: &str = "k";

/// A request head larger than this is not one a browser sent.
const MAX_HEAD: usize = 16 * 1024;

/// How long a connection may take to produce a complete request head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(20);

/// How long a paired browser stays paired without rescanning.
const COOKIE_MAX_AGE: u32 = 60 * 60 * 12;

/// What the panel counts.
#[derive(Debug, Default)]
pub struct Counters {
    /// Connections currently relaying.
    pub active: AtomicU32,
    /// Connections relayed since this gateway started.
    pub served: AtomicU64,
    /// Requests turned away for want of a valid token.
    pub refused: AtomicU64,
}

/// Accept connections until the sender behind `shutdown` is dropped, which is
/// what closing the door does.
///
/// A receiver, not a sender: nothing inside this gateway may hold something
/// that keeps the channel open, or closing the door would leave the listener
/// waiting for a signal that can no longer arrive.
pub async fn serve(
    listener: TcpListener,
    token: Arc<String>,
    upstream: SocketAddr,
    counters: Arc<Counters>,
    mut closing: broadcast::Receiver<()>,
    changed: broadcast::Sender<()>,
) {
    loop {
        let accepted = tokio::select! {
            _ = closing.recv() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((socket, _peer)) = accepted else {
            // A single failed accept — a descriptor limit, a connection reset
            // between the kernel queueing it and us taking it — is not a reason
            // to stop listening. Anything fatal will fail again next time round.
            continue;
        };

        let token = Arc::clone(&token);
        let counters = Arc::clone(&counters);
        // Derived from the receiver rather than from a sender, for the reason
        // above: this task must not be able to keep the door open either.
        let connection_closing = closing.resubscribe();
        let changed = changed.clone();
        tokio::spawn(async move {
            let _ = socket.set_nodelay(true);
            relay(
                socket,
                token,
                upstream,
                counters,
                connection_closing,
                &changed,
            )
            .await;
            // Every connection that opens or closes is a number the panel shows,
            // so the panel is told rather than left to poll.
            let _ = changed.send(());
        });
    }
}

async fn relay(
    mut inbound: TcpStream,
    token: Arc<String>,
    upstream: SocketAddr,
    counters: Arc<Counters>,
    mut shutdown: broadcast::Receiver<()>,
    changed: &broadcast::Sender<()>,
) {
    let Some(head) = read_head(&mut inbound).await else {
        return;
    };

    match decide(&head, &token) {
        Decision::Pair { destination } => {
            let response = pair_response(&token, &destination);
            let _ = inbound.write_all(response.as_bytes()).await;
            let _ = inbound.shutdown().await;
        }
        Decision::Refuse => {
            counters.refused.fetch_add(1, Ordering::Relaxed);
            let _ = inbound.write_all(REFUSED.as_bytes()).await;
            let _ = inbound.shutdown().await;
        }
        Decision::Forward => {
            counters.served.fetch_add(1, Ordering::Relaxed);
            counters.active.fetch_add(1, Ordering::Relaxed);
            let _ = changed.send(());

            forward(&mut inbound, &head, upstream, &mut shutdown).await;
            counters.active.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

async fn forward(
    inbound: &mut TcpStream,
    head: &Head,
    upstream: SocketAddr,
    shutdown: &mut broadcast::Receiver<()>,
) {
    let Ok(mut outbound) = TcpStream::connect(upstream).await else {
        let _ = inbound.write_all(UNAVAILABLE.as_bytes()).await;
        let _ = inbound.shutdown().await;
        return;
    };
    let _ = outbound.set_nodelay(true);

    if outbound.write_all(&head.rewritten(upstream)).await.is_err() {
        return;
    }

    tokio::select! {
        _ = shutdown.recv() => {}
        _ = tokio::io::copy_bidirectional(inbound, &mut outbound) => {}
    }
}

/// What to do with one request.
enum Decision {
    /// The token was in the URL: set the cookie and send the browser on.
    Pair { destination: String },
    /// The cookie was valid: relay it.
    Forward,
    /// Neither: say so, and say nothing else.
    Refuse,
}

fn decide(head: &Head, token: &str) -> Decision {
    if let Some(offered) = head.query_token() {
        if constant_time_eq(offered.as_bytes(), token.as_bytes()) {
            return Decision::Pair {
                destination: head.path_without_token(),
            };
        }
        return Decision::Refuse;
    }

    match head.cookie_token() {
        Some(offered) if constant_time_eq(offered.as_bytes(), token.as_bytes()) => {
            Decision::Forward
        }
        _ => Decision::Refuse,
    }
}

/// One parsed request head, plus whatever body bytes arrived with it.
struct Head {
    line: String,
    headers: Vec<(String, String)>,
    /// Bytes read past the header block, which belong to the body.
    overflow: Vec<u8>,
}

impl Head {
    /// The request target, e.g. `/session?id=4`.
    fn target(&self) -> &str {
        self.line.split(' ').nth(1).unwrap_or("/")
    }

    fn query_token(&self) -> Option<String> {
        let (_, query) = self.target().split_once('?')?;
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == PAIR_PARAM).then(|| value.to_string())
        })
    }

    /// Where to send a freshly paired browser: the same place, minus the
    /// secret. Leaving the token in the address bar would put it in the phone's
    /// history and in every `Referer` the page later sends.
    fn path_without_token(&self) -> String {
        let target = self.target();
        let Some((path, query)) = target.split_once('?') else {
            return target.to_string();
        };
        let kept: Vec<&str> = query
            .split('&')
            .filter(|pair| !pair.starts_with(&format!("{PAIR_PARAM}=")))
            .filter(|pair| !pair.is_empty())
            .collect();

        let path = if path.is_empty() { "/" } else { path };
        if kept.is_empty() {
            path.to_string()
        } else {
            format!("{path}?{}", kept.join("&"))
        }
    }

    fn cookie_token(&self) -> Option<String> {
        let value = self.header("cookie")?;
        value.split(';').find_map(|pair| {
            let (key, value) = pair.trim().split_once('=')?;
            (key == COOKIE).then(|| value.to_string())
        })
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    /// The head as the harness should see it.
    ///
    /// `Host` and `Origin` are rewritten to the loopback address the service
    /// actually bound, because a service that checks either one is checking for
    /// exactly the case where a request arrives claiming a name it does not
    /// serve — which is every request through this gateway.
    fn rewritten(&self, upstream: SocketAddr) -> Vec<u8> {
        let authority = upstream.to_string();
        let mut out = String::with_capacity(512);
        out.push_str(&self.line);
        out.push_str("\r\n");

        for (name, value) in &self.headers {
            let replacement = if name.eq_ignore_ascii_case("host") {
                Some(authority.clone())
            } else if name.eq_ignore_ascii_case("origin") {
                Some(format!("http://{authority}"))
            } else {
                None
            };
            out.push_str(name);
            out.push_str(": ");
            out.push_str(replacement.as_deref().unwrap_or(value));
            out.push_str("\r\n");
        }
        out.push_str("\r\n");

        let mut bytes = out.into_bytes();
        bytes.extend_from_slice(&self.overflow);
        bytes
    }
}

/// Read until the end of the header block.
///
/// Header bytes are ASCII in every request a browser produces; the lossy
/// conversion is what lets the rest of this module work in `str`, and a request
/// that needed anything else would not be one the harness could answer.
async fn read_head(socket: &mut TcpStream) -> Option<Head> {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];

    let deadline = tokio::time::sleep(HEAD_TIMEOUT);
    tokio::pin!(deadline);

    let end = loop {
        if let Some(at) = find_blank_line(&buffer) {
            break at;
        }
        if buffer.len() > MAX_HEAD {
            return None;
        }

        let read = tokio::select! {
            _ = &mut deadline => return None,
            read = socket.read(&mut chunk) => read,
        };
        match read {
            Ok(0) | Err(_) => return None,
            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
        }
    };

    let text = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let mut lines = text.split("\r\n");
    let line = lines.next()?.to_string();
    if line.is_empty() {
        return None;
    }

    let headers = lines
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| entry.split_once(':'))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect();

    Some(Head {
        line,
        headers,
        overflow: buffer[end + 4..].to_vec(),
    })
}

/// Offset of the `\r\n\r\n` that ends a header block.
fn find_blank_line(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

/// Compare without leaking, through timing, how much of a guess was right.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

fn pair_response(token: &str, destination: &str) -> String {
    // HttpOnly keeps the token out of any script the harness happens to run;
    // SameSite=Lax keeps another site from steering the phone into using it.
    // Not `Secure`: this is plain HTTP on a local network, and a cookie marked
    // Secure would simply never be sent back.
    format!(
        "HTTP/1.1 303 See Other\r\n\
         Location: {destination}\r\n\
         Set-Cookie: {COOKIE}={token}; Path=/; Max-Age={COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax\r\n\
         Cache-Control: no-store\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\r\n"
    )
}

/// Deliberately uninformative, and deliberately not a login form: there is
/// nothing to type here, and a page that invited typing would be inviting
/// guesses.
const REFUSED: &str = concat!(
    "HTTP/1.1 401 Unauthorized\r\n",
    "Content-Type: text/html; charset=utf-8\r\n",
    "Cache-Control: no-store\r\n",
    "Connection: close\r\n\r\n",
    "<!doctype html><meta charset=utf-8>",
    "<meta name=viewport content=\"width=device-width,initial-scale=1\">",
    "<title>Pairing required</title>",
    "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;",
    "font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;",
    "background:#0d0f12;color:#e6e8ec}div{max-width:22rem;padding:2rem;text-align:center}",
    "p{color:#9aa0aa;margin:.5rem 0 0}</style>",
    "<div><strong>Scan the code again</strong>",
    "<p>This link only works with the pairing code shown in DSH Studio.</p>",
    "<p>请重新扫描 DSH Studio 中显示的配对二维码。</p></div>"
);

const UNAVAILABLE: &str = concat!(
    "HTTP/1.1 502 Bad Gateway\r\n",
    "Content-Type: text/plain; charset=utf-8\r\n",
    "Connection: close\r\n\r\n",
    "The harness is not answering right now."
);

#[cfg(test)]
mod tests {
    use super::*;

    fn head(raw: &str) -> Head {
        let bytes = raw.as_bytes().to_vec();
        let end = find_blank_line(&bytes).expect("test head is complete");
        let text = String::from_utf8_lossy(&bytes[..end]).into_owned();
        let mut lines = text.split("\r\n");
        let line = lines.next().expect("request line").to_string();
        let headers = lines
            .filter(|entry| !entry.is_empty())
            .filter_map(|entry| entry.split_once(':'))
            .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
            .collect();
        Head {
            line,
            headers,
            overflow: bytes[end + 4..].to_vec(),
        }
    }

    #[test]
    fn pairs_on_the_token_in_the_url() {
        let request = head("GET /?k=secret HTTP/1.1\r\nHost: 192.168.1.5:9\r\n\r\n");
        assert!(matches!(decide(&request, "secret"), Decision::Pair { .. }));
    }

    #[test]
    fn refuses_a_wrong_token_without_falling_back_to_the_cookie() {
        // A stale QR code plus a valid cookie must not silently succeed: the
        // user is telling us which credential they mean.
        let request =
            head("GET /?k=wrong HTTP/1.1\r\nHost: h\r\nCookie: dsh_studio_remote=secret\r\n\r\n");
        assert!(matches!(decide(&request, "secret"), Decision::Refuse));
    }

    #[test]
    fn forwards_once_the_cookie_is_set() {
        let request =
            head("GET /app HTTP/1.1\r\nHost: h\r\nCookie: dsh_studio_remote=secret\r\n\r\n");
        assert!(matches!(decide(&request, "secret"), Decision::Forward));
    }

    #[test]
    fn refuses_a_request_with_no_credential_at_all() {
        let request = head("GET / HTTP/1.1\r\nHost: h\r\n\r\n");
        assert!(matches!(decide(&request, "secret"), Decision::Refuse));
    }

    #[test]
    fn refuses_a_cookie_that_only_shares_a_prefix() {
        let request = head("GET / HTTP/1.1\r\nHost: h\r\nCookie: dsh_studio_remote=sec\r\n\r\n");
        assert!(matches!(decide(&request, "secret"), Decision::Refuse));
    }

    #[test]
    fn finds_the_cookie_among_others() {
        let request = head(
            "GET / HTTP/1.1\r\nHost: h\r\nCookie: theme=dark; dsh_studio_remote=secret; lang=zh\r\n\r\n",
        );
        assert!(matches!(decide(&request, "secret"), Decision::Forward));
    }

    #[test]
    fn strips_the_token_from_the_address_the_browser_lands_on() {
        let request = head("GET /chat?k=secret&id=7 HTTP/1.1\r\nHost: h\r\n\r\n");
        assert_eq!(request.path_without_token(), "/chat?id=7");

        let bare = head("GET /?k=secret HTTP/1.1\r\nHost: h\r\n\r\n");
        assert_eq!(bare.path_without_token(), "/");
    }

    #[test]
    fn rewrites_host_and_origin_to_the_loopback_service() {
        let request = head(
            "GET / HTTP/1.1\r\nHost: 192.168.1.5:7000\r\nOrigin: http://192.168.1.5:7000\r\nAccept: */*\r\n\r\n",
        );
        let upstream: SocketAddr = "127.0.0.1:41234".parse().expect("addr");
        let rewritten = String::from_utf8(request.rewritten(upstream)).expect("utf-8");

        assert!(rewritten.contains("Host: 127.0.0.1:41234"));
        assert!(rewritten.contains("Origin: http://127.0.0.1:41234"));
        assert!(rewritten.contains("Accept: */*"), "other headers survive");
        assert!(rewritten.ends_with("\r\n\r\n"));
    }

    #[test]
    fn carries_body_bytes_that_arrived_with_the_head() {
        let request = head("POST /m HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nhello");
        let upstream: SocketAddr = "127.0.0.1:1".parse().expect("addr");
        let rewritten = request.rewritten(upstream);
        assert!(rewritten.ends_with(b"hello"));
    }

    #[test]
    fn compares_in_constant_time_without_being_wrong() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    /// An upstream that answers with whatever it was asked, so a test can see
    /// exactly what the gateway forwarded.
    async fn echoing_upstream() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");

        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 2048];
                let read = socket.read(&mut buffer).await.unwrap_or_default();
                let seen = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{seen}",
                    seen.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        address
    }

    async fn speak(door: SocketAddr, request: &str) -> String {
        let mut socket = TcpStream::connect(door).await.expect("connect");
        socket.write_all(request.as_bytes()).await.expect("write");

        let mut reply = String::new();
        let _ = socket.read_to_string(&mut reply).await;
        reply
    }

    /// Everything the door does, against a real socket, in the order a phone
    /// would do it: turned away, then paired, then carried through.
    #[tokio::test]
    async fn turns_away_pairs_and_then_relays() {
        let upstream = echoing_upstream().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let door = listener.local_addr().expect("addr");
        let counters = Arc::new(Counters::default());
        let shutdown = broadcast::channel::<()>(1).0;

        tokio::spawn(serve(
            listener,
            Arc::new("secret".to_string()),
            upstream,
            Arc::clone(&counters),
            shutdown.subscribe(),
            broadcast::channel::<()>(8).0,
        ));

        let refused = speak(door, "GET / HTTP/1.1\r\nHost: phone\r\n\r\n").await;
        assert!(refused.starts_with("HTTP/1.1 401"), "{refused}");
        assert!(
            !refused.contains("secret"),
            "a refusal must not leak the thing it refused over"
        );

        let paired = speak(door, "GET /chat?k=secret HTTP/1.1\r\nHost: phone\r\n\r\n").await;
        assert!(paired.starts_with("HTTP/1.1 303"), "{paired}");
        assert!(paired.contains("Set-Cookie: dsh_studio_remote=secret"));
        assert!(paired.contains("Location: /chat"), "the secret is dropped");

        let relayed = speak(
            door,
            "GET /chat HTTP/1.1\r\nHost: phone\r\nCookie: dsh_studio_remote=secret\r\n\r\n",
        )
        .await;
        assert!(relayed.starts_with("HTTP/1.1 200"), "{relayed}");
        assert!(
            relayed.contains("GET /chat HTTP/1.1"),
            "the request arrived"
        );
        assert!(
            relayed.contains(&format!("Host: {upstream}")),
            "rewritten for the service that is actually listening"
        );

        assert_eq!(counters.served.load(Ordering::Relaxed), 1);
        assert_eq!(counters.refused.load(Ordering::Relaxed), 1);

        // The relay outlives the reply by however long it takes both halves to
        // finish, so this is waited for rather than asserted on the spot.
        for _ in 0..50 {
            if counters.active.load(Ordering::Relaxed) == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("a finished connection was still counted as active");
    }

    /// Closing the door means the port stops answering, not that the next
    /// request is politely declined.
    #[tokio::test]
    async fn dropping_the_shutdown_sender_stops_the_listener() {
        let upstream = echoing_upstream().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let door = listener.local_addr().expect("addr");
        let shutdown = broadcast::channel::<()>(1).0;

        tokio::spawn(serve(
            listener,
            Arc::new("secret".to_string()),
            upstream,
            Arc::new(Counters::default()),
            shutdown.subscribe(),
            broadcast::channel::<()>(8).0,
        ));
        assert!(TcpStream::connect(door).await.is_ok(), "open to begin with");

        drop(shutdown);

        // The loop wakes, breaks, and drops the listener; poll rather than
        // guess how long that takes on a loaded machine.
        for _ in 0..50 {
            if TcpStream::connect(door).await.is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the door was still open a second after it was closed");
    }
}

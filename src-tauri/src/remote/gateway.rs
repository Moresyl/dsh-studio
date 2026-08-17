//! The door: an authenticated TCP relay from the local network to a service
//! that is still bound to loopback.
//!
//! The harness never learns any of this exists. It keeps its kernel-assigned
//! port on `127.0.0.1`, and this listener — started only when a person asks for
//! it — is the single place where a packet from another device can turn into a
//! packet to that port. What separates the two is a credential, and which
//! credentials exist is [`Access`]'s business rather than this module's: here a
//! request is read, asked about, and either carried or refused.
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

use super::access::Access;

/// Cookie a device gets after pairing, and presents on every later request.
const COOKIE: &str = "dsh_studio_remote";

/// Query parameter carrying the pairing code in the scanned URL.
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
    /// Requests turned away for want of a valid credential.
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
    access: Arc<Access>,
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

        let access = Arc::clone(&access);
        let counters = Arc::clone(&counters);
        // Derived from the receiver rather than from a sender, for the reason
        // above: this task must not be able to keep the door open either.
        let connection_closing = closing.resubscribe();
        let changed = changed.clone();
        tokio::spawn(async move {
            let _ = socket.set_nodelay(true);
            relay(
                socket,
                access,
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
    access: Arc<Access>,
    upstream: SocketAddr,
    counters: Arc<Counters>,
    mut shutdown: broadcast::Receiver<()>,
    changed: &broadcast::Sender<()>,
) {
    let Some(head) = read_head(&mut inbound).await else {
        return;
    };

    match decide(&head, &access) {
        Decision::Pair {
            cookie,
            destination,
        } => {
            let response = pair_response(&cookie, &destination);
            let _ = inbound.write_all(response.as_bytes()).await;
            let _ = inbound.shutdown().await;
            // A device that has just paired is a row the panel has to grow.
            let _ = changed.send(());
        }
        Decision::Refuse => {
            counters.refused.fetch_add(1, Ordering::Relaxed);
            let _ = inbound.write_all(REFUSED.as_bytes()).await;
            let _ = inbound.shutdown().await;
        }
        Decision::Forward { device } => {
            counters.served.fetch_add(1, Ordering::Relaxed);
            counters.active.fetch_add(1, Ordering::Relaxed);
            let _ = changed.send(());

            forward(
                &mut inbound,
                &head,
                upstream,
                &access,
                &device,
                &mut shutdown,
            )
            .await;
            counters.active.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

async fn forward(
    inbound: &mut TcpStream,
    head: &Head,
    upstream: SocketAddr,
    access: &Access,
    device: &str,
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

    // Subscribed before the first byte moves, so a revocation cannot slip
    // through the gap between deciding to relay and starting to.
    let mut revocations = access.watch_revocations();

    tokio::select! {
        _ = shutdown.recv() => {}
        _ = revoked(&mut revocations, device) => {}
        _ = tokio::io::copy_bidirectional(inbound, &mut outbound) => {}
    }
}

/// Resolve when this connection's own device is forgotten.
///
/// A long-lived stream is exactly the case a revoke button exists for — a phone
/// left behind with an open session is not turned away by refusing its *next*
/// request, because it may not make one for hours.
async fn revoked(revocations: &mut broadcast::Receiver<String>, device: &str) {
    loop {
        match revocations.recv().await {
            Ok(id) if id == device => return,
            Ok(_) => continue,
            // Missing a revocation is a reason to end the relay, not to keep
            // going on a credential that may no longer exist.
            Err(_) => return,
        }
    }
}

/// What to do with one request.
enum Decision {
    /// A live pairing code was in the URL: hand this device a credential of its
    /// own and send it back without the code in the address.
    Pair { cookie: String, destination: String },
    /// The cookie named a device this door still knows: relay it.
    Forward { device: String },
    /// Neither: say so, and say nothing else.
    Refuse,
}

fn decide(head: &Head, access: &Access) -> Decision {
    // A code in the URL is the user saying which credential they mean, so a
    // stale QR presented by an already-paired phone is a refusal rather than a
    // quiet success on the cookie it happens to still hold.
    if let Some(offered) = head.query_code() {
        let agent = head.header("user-agent").unwrap_or_default();
        return match access.pair(&offered, agent) {
            Some(cookie) => Decision::Pair {
                cookie,
                destination: head.path_without_code(),
            },
            None => Decision::Refuse,
        };
    }

    match head
        .cookie_credential()
        .and_then(|held| access.admit(&held))
    {
        Some(device) => Decision::Forward { device },
        None => Decision::Refuse,
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

    fn query_code(&self) -> Option<String> {
        let (_, query) = self.target().split_once('?')?;
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == PAIR_PARAM).then(|| value.to_string())
        })
    }

    /// Where to send a freshly paired browser: the same place, minus the code.
    /// Leaving it in the address bar would put it in the phone's history and in
    /// every `Referer` the page later sends.
    fn path_without_code(&self) -> String {
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

    fn cookie_credential(&self) -> Option<String> {
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

fn pair_response(cookie: &str, destination: &str) -> String {
    // HttpOnly keeps the credential out of any script the harness happens to
    // run; SameSite=Lax keeps another site from steering the phone into using
    // it. Not `Secure`: this is plain HTTP on a local network, and a cookie
    // marked Secure would simply never be sent back.
    format!(
        "HTTP/1.1 303 See Other\r\n\
         Location: {destination}\r\n\
         Set-Cookie: {COOKIE}={cookie}; Path=/; Max-Age={COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax\r\n\
         Cache-Control: no-store\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\r\n"
    )
}

/// Deliberately uninformative, and deliberately not a login form: there is
/// nothing to type here, and a page that invited typing would be inviting
/// guesses. It also does not say which of the three reasons applied — an
/// expired code, a spent one, or a device that was removed — because that
/// distinction is only useful to someone who is not supposed to be here.
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
    "<div><strong>Scan a fresh code</strong>",
    "<p>A pairing code works once and expires after two minutes. Open DSH Studio",
    " for a new one.</p>",
    "<p>配对码只能用一次，两分钟后失效。请在 DSH Studio 中换一个新的二维码再扫。</p></div>"
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

    /// A door nobody has come through yet, and the code on its screen.
    fn waiting() -> (Arc<Access>, String) {
        let access = Arc::new(Access::open().expect("the test machine has entropy"));
        let code = access.pairing().expect("a fresh door shows a code").code;
        (access, code)
    }

    /// The credential out of a pairing response, as a browser would keep it.
    fn credential_in(response: &str) -> String {
        let line = response
            .lines()
            .find(|line| line.starts_with("Set-Cookie:"))
            .expect("a pairing response sets a cookie");
        let value = line.split_once('=').expect("a cookie has a value").1;
        value
            .split(';')
            .next()
            .expect("the value before the attributes")
            .to_string()
    }

    #[test]
    fn pairs_on_the_code_in_the_url() {
        let (access, code) = waiting();
        let request = head(&format!(
            "GET /?k={code} HTTP/1.1\r\nHost: 192.168.1.5:9\r\n\r\n"
        ));
        assert!(matches!(decide(&request, &access), Decision::Pair { .. }));
    }

    #[test]
    fn refuses_a_wrong_code_without_falling_back_to_the_cookie() {
        // A stale QR code plus a valid cookie must not silently succeed: the
        // user is telling us which credential they mean.
        let (access, code) = waiting();
        let held = access.pair(&code, "").expect("pairs");
        access.renew().expect("entropy");

        let request = head(&format!(
            "GET /?k=wrong HTTP/1.1\r\nHost: h\r\nCookie: {COOKIE}={held}\r\n\r\n"
        ));
        assert!(matches!(decide(&request, &access), Decision::Refuse));
    }

    #[test]
    fn forwards_once_the_device_holds_its_own_credential() {
        let (access, code) = waiting();
        let held = access.pair(&code, "").expect("pairs");

        let request = head(&format!(
            "GET /app HTTP/1.1\r\nHost: h\r\nCookie: {COOKIE}={held}\r\n\r\n"
        ));
        assert!(matches!(
            decide(&request, &access),
            Decision::Forward { .. }
        ));
    }

    #[test]
    fn refuses_a_request_with_no_credential_at_all() {
        let (access, _) = waiting();
        let request = head("GET / HTTP/1.1\r\nHost: h\r\n\r\n");
        assert!(matches!(decide(&request, &access), Decision::Refuse));
    }

    #[test]
    fn refuses_the_pairing_code_offered_as_a_cookie() {
        // The code buys a credential; it is not one. Presenting it as one would
        // be a way to keep using a secret that was meant to last two minutes.
        let (access, code) = waiting();
        let request = head(&format!(
            "GET / HTTP/1.1\r\nHost: h\r\nCookie: {COOKIE}={code}\r\n\r\n"
        ));
        assert!(matches!(decide(&request, &access), Decision::Refuse));
    }

    #[test]
    fn refuses_a_credential_that_only_shares_a_prefix() {
        let (access, code) = waiting();
        let held = access.pair(&code, "").expect("pairs");
        let short = &held[..held.len() - 1];

        let request = head(&format!(
            "GET / HTTP/1.1\r\nHost: h\r\nCookie: {COOKIE}={short}\r\n\r\n"
        ));
        assert!(matches!(decide(&request, &access), Decision::Refuse));
    }

    #[test]
    fn finds_the_cookie_among_others() {
        let (access, code) = waiting();
        let held = access.pair(&code, "").expect("pairs");

        let request = head(&format!(
            "GET / HTTP/1.1\r\nHost: h\r\nCookie: theme=dark; {COOKIE}={held}; lang=zh\r\n\r\n"
        ));
        assert!(matches!(
            decide(&request, &access),
            Decision::Forward { .. }
        ));
    }

    #[test]
    fn strips_the_code_from_the_address_the_browser_lands_on() {
        let request = head("GET /chat?k=secret&id=7 HTTP/1.1\r\nHost: h\r\n\r\n");
        assert_eq!(request.path_without_code(), "/chat?id=7");

        let bare = head("GET /?k=secret HTTP/1.1\r\nHost: h\r\n\r\n");
        assert_eq!(bare.path_without_code(), "/");
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
        let (access, code) = waiting();

        tokio::spawn(serve(
            listener,
            access,
            upstream,
            Arc::clone(&counters),
            shutdown.subscribe(),
            broadcast::channel::<()>(8).0,
        ));

        let refused = speak(door, "GET / HTTP/1.1\r\nHost: phone\r\n\r\n").await;
        assert!(refused.starts_with("HTTP/1.1 401"), "{refused}");
        assert!(
            !refused.contains(&code),
            "a refusal must not leak the thing it refused over"
        );

        let paired = speak(
            door,
            &format!("GET /chat?k={code} HTTP/1.1\r\nHost: phone\r\n\r\n"),
        )
        .await;
        assert!(paired.starts_with("HTTP/1.1 303"), "{paired}");
        assert!(paired.contains("Location: /chat"), "the code is dropped");

        let held = credential_in(&paired);
        assert!(
            !held.contains(&code),
            "what the device keeps is not the code it arrived with"
        );

        let relayed = speak(
            door,
            &format!("GET /chat HTTP/1.1\r\nHost: phone\r\nCookie: {COOKIE}={held}\r\n\r\n"),
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

        // The code was spent by the pairing, so the same scan cannot be replayed.
        let replayed = speak(
            door,
            &format!("GET /chat?k={code} HTTP/1.1\r\nHost: phone\r\n\r\n"),
        )
        .await;
        assert!(replayed.starts_with("HTTP/1.1 401"), "{replayed}");

        assert_eq!(counters.served.load(Ordering::Relaxed), 1);
        assert_eq!(counters.refused.load(Ordering::Relaxed), 2);

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

    /// Forgetting a device has to reach the connection it already had open.
    /// A phone holding an event stream would otherwise keep receiving for
    /// hours after being revoked, because it never makes another request to be
    /// refused.
    #[tokio::test]
    async fn forgetting_a_device_ends_the_stream_it_left_open() {
        // An upstream that accepts and then says nothing — a stream, from the
        // relay's point of view.
        let silent = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let upstream = silent.local_addr().expect("addr");
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = silent.accept().await {
                held.push(socket);
            }
        });

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let door = listener.local_addr().expect("addr");
        let counters = Arc::new(Counters::default());
        let shutdown = broadcast::channel::<()>(1).0;
        let (access, code) = waiting();

        tokio::spawn(serve(
            listener,
            Arc::clone(&access),
            upstream,
            Arc::clone(&counters),
            shutdown.subscribe(),
            broadcast::channel::<()>(8).0,
        ));

        let held = access.pair(&code, "").expect("pairs");
        let device = access.admit(&held).expect("known");

        let mut phone = TcpStream::connect(door).await.expect("connect");
        phone
            .write_all(
                format!("GET /events HTTP/1.1\r\nHost: phone\r\nCookie: {COOKIE}={held}\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .expect("write");

        // Revoke only once the relay is genuinely up, or the test would be
        // proving that a connection which never started also never continued.
        for _ in 0..100 {
            if counters.active.load(Ordering::Relaxed) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(counters.active.load(Ordering::Relaxed), 1, "relaying");

        assert!(access.forget(&device));

        let mut byte = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_secs(5), phone.read(&mut byte)).await;
        assert!(
            matches!(read, Ok(Ok(0))),
            "the socket should have closed with the credential, got {read:?}"
        );
    }

    /// Closing the door means the port stops answering, not that the next
    /// request is politely declined.
    #[tokio::test]
    async fn dropping_the_shutdown_sender_stops_the_listener() {
        let upstream = echoing_upstream().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let door = listener.local_addr().expect("addr");
        let shutdown = broadcast::channel::<()>(1).0;
        let (access, _) = waiting();

        tokio::spawn(serve(
            listener,
            access,
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

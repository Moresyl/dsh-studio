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
//! Each HTTP connection is authenticated and gets loopback-owned credentials
//! in its first request head. Ordinary responses close the connection, so the
//! next request cannot bypass header rewriting. Streaming responses and upgraded
//! WebSockets keep relaying bytes until completion, shutdown or device revocation.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, watch, OwnedSemaphorePermit, Semaphore};

use super::access::Access;
use super::upstream::Upstream;

/// Cookie a device gets after pairing, and presents on every later request.
const COOKIE: &str = "dsh_studio_remote";

/// Query parameter carrying the pairing code in the scanned URL.
const PAIR_PARAM: &str = "k";

/// A request head larger than this is not one a browser sent.
const MAX_HEAD: usize = 16 * 1024;

/// How long a connection may take to produce a complete request head.
const HEAD_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CONNECTIONS: usize = 128;

/// How long a paired browser stays paired without rescanning.
const COOKIE_MAX_AGE: u32 = 60 * 60 * 12;

/// The externally visible origin is supplied by Studio, never by forwarded
/// request headers. Pending public gateways cannot consume pairing codes.
#[derive(Clone, Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Public tunnel audiences are staged; production currently selects LAN only"
    )
)]
pub enum Audience {
    Lan,
    Pending,
    Https(url::Url),
}

impl Audience {
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "The staged tunnel controller will supply its verified public origin"
        )
    )]
    pub fn https(origin: &str) -> crate::error::Result<Self> {
        let url = url::Url::parse(origin)
            .map_err(|_| crate::error::Error::RemoteTunnel("invalid public origin".into()))?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(crate::error::Error::RemoteTunnel(
                "invalid public origin".into(),
            ));
        }
        Ok(Self::Https(url))
    }
}

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
    upstream: impl Into<Upstream>,
    counters: Arc<Counters>,
    closing: broadcast::Receiver<()>,
    changed: broadcast::Sender<()>,
) {
    let (_, audience) = watch::channel(Audience::Lan);
    serve_with_audience(
        listener, access, upstream, counters, closing, changed, audience,
    )
    .await;
}

pub async fn serve_with_audience(
    listener: TcpListener,
    access: Arc<Access>,
    upstream: impl Into<Upstream>,
    counters: Arc<Counters>,
    mut closing: broadcast::Receiver<()>,
    changed: broadcast::Sender<()>,
    audience: watch::Receiver<Audience>,
) {
    let upstream = Arc::new(upstream.into());
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));
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
        let Some(permit) = connection_permit(&permits) else {
            counters.refused.fetch_add(1, Ordering::Relaxed);
            continue;
        };

        let access = Arc::clone(&access);
        let upstream = Arc::clone(&upstream);
        let counters = Arc::clone(&counters);
        // Derived from the receiver rather than from a sender, for the reason
        // above: this task must not be able to keep the door open either.
        let connection_closing = closing.resubscribe();
        let changed = changed.clone();
        let audience = audience.borrow().clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = socket.set_nodelay(true);
            relay(
                socket,
                access,
                &upstream,
                counters,
                connection_closing,
                &changed,
                &audience,
            )
            .await;
            // Every connection that opens or closes is a number the panel shows,
            // so the panel is told rather than left to poll.
            let _ = changed.send(());
        });
    }
}

fn connection_permit(permits: &Arc<Semaphore>) -> Option<OwnedSemaphorePermit> {
    Arc::clone(permits).try_acquire_owned().ok()
}

async fn relay(
    mut inbound: TcpStream,
    access: Arc<Access>,
    upstream: &Upstream,
    counters: Arc<Counters>,
    mut shutdown: broadcast::Receiver<()>,
    changed: &broadcast::Sender<()>,
    audience: &Audience,
) {
    // Closing access also cancels incomplete headers and upstream setup, not
    // just connections which have already reached the streaming phase.
    tokio::select! {
        biased;
        _ = shutdown.recv() => {}
        _ = relay_open(&mut inbound, access, upstream, counters, changed, audience) => {}
    }
}

async fn relay_open(
    inbound: &mut TcpStream,
    access: Arc<Access>,
    upstream: &Upstream,
    counters: Arc<Counters>,
    changed: &broadcast::Sender<()>,
    audience: &Audience,
) {
    let Some(head) = read_head(inbound).await else {
        return;
    };

    // Subscribe before authentication. A device removed after admission must
    // remain observable even while connecting or writing to the upstream.
    let mut revocations = access.watch_revocations();
    match decide_for(&head, &access, audience) {
        Decision::Pair {
            cookie,
            destination,
        } => {
            let response = pair_response(
                &cookie,
                &destination,
                matches!(audience, Audience::Https(_)),
            );
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

            let _active = ActiveConnection(&counters);
            forward(inbound, &head, upstream, &device, &mut revocations).await;
        }
    }
}

// Cancellation drops the relay future; keep accounting correct on that path
// as well as on ordinary EOF and revocation.
struct ActiveConnection<'a>(&'a Counters);

impl Drop for ActiveConnection<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn forward(
    inbound: &mut TcpStream,
    head: &Head,
    upstream: &Upstream,
    device: &str,
    revocations: &mut broadcast::Receiver<String>,
) {
    tokio::select! {
        biased;
        _ = revoked(revocations, device) => {}
        _ = forward_open(inbound, head, upstream) => {}
    }
}

async fn forward_open(inbound: &mut TcpStream, head: &Head, upstream: &Upstream) {
    let Ok(mut outbound) = TcpStream::connect(upstream.address).await else {
        let _ = inbound.write_all(UNAVAILABLE.as_bytes()).await;
        let _ = inbound.shutdown().await;
        return;
    };
    let _ = outbound.set_nodelay(true);

    if outbound.write_all(&head.rewritten(upstream)).await.is_err() {
        return;
    }

    let _ = tokio::io::copy_bidirectional(inbound, &mut outbound).await;
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

fn decide_for(head: &Head, access: &Access, audience: &Audience) -> Decision {
    // Check the browser's original authority before replacing Origin/Host for
    // the loopback service. Same-site requests from a different port are not
    // same-origin, even though the browser may attach the pairing cookie.
    if !head.trusted_origin(audience) {
        return Decision::Refuse;
    }
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
    fn trusted_origin(&self, audience: &Audience) -> bool {
        if matches!(audience, Audience::Pending) {
            return false;
        }
        for name in ["host", "origin", "sec-fetch-site"] {
            if self
                .headers
                .iter()
                .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                .count()
                > 1
            {
                return false;
            }
        }
        if self
            .header("sec-fetch-site")
            .is_some_and(|site| !matches!(site, "same-origin" | "none"))
        {
            return false;
        }
        // Internet gateways require the configured public authority even for
        // navigations without Origin; a spoofed forwarded host never enables it.
        if let Audience::Https(expected) = audience {
            let authority = &expected[url::Position::BeforeHost..url::Position::AfterPort];
            if !self
                .header("host")
                .is_some_and(|host| host.eq_ignore_ascii_case(authority))
            {
                return false;
            }
        }
        let Some(origin) = self.header("origin") else {
            return true;
        };
        let Some(host) = self.header("host") else {
            return false;
        };
        let expected = match audience {
            Audience::Https(url) => url.clone(),
            Audience::Lan => match url::Url::parse(&format!("http://{host}")) {
                Ok(url) => url,
                Err(_) => return false,
            },
            Audience::Pending => return false,
        };
        let Ok(offered) = url::Url::parse(origin) else {
            return false;
        };
        offered.origin() == expected.origin()
            && offered.scheme() == expected.scheme()
            && offered.username().is_empty()
            && offered.password().is_none()
            && offered.path() == "/"
            && offered.query().is_none()
            && offered.fragment().is_none()
    }

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
        if !safe_local_target(target) {
            return "/".into();
        }
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
    fn rewritten(&self, upstream: &Upstream) -> Vec<u8> {
        let authority = upstream.address.to_string();
        let mut out = String::with_capacity(512);
        out.push_str(&self.line);
        out.push_str("\r\n");

        for (name, value) in &self.headers {
            if name.eq_ignore_ascii_case("cookie") || name.eq_ignore_ascii_case("connection") {
                continue;
            }
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
        if let Some(cookie) = &upstream.cookie {
            out.push_str("Cookie: ");
            out.push_str(cookie);
            out.push_str("\r\n");
        }
        // Only the first HTTP head is rewritten. Force another authenticated
        // gateway connection for the next request; upgraded streams keep their
        // duplex transport, and SSE keeps streaming until its response ends.
        if self
            .header("upgrade")
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        {
            out.push_str("Connection: Upgrade\r\n");
        } else {
            out.push_str("Connection: close\r\n");
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
        match bounded_head_end(&buffer) {
            Ok(Some(at)) => break at,
            Err(()) => return None,
            Ok(None) => {}
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

fn bounded_head_end(buffer: &[u8]) -> Result<Option<usize>, ()> {
    match find_blank_line(buffer) {
        Some(at) if at.saturating_add(4) <= MAX_HEAD => Ok(Some(at)),
        Some(_) => Err(()),
        None if buffer.len() > MAX_HEAD => Err(()),
        None => Ok(None),
    }
}

fn safe_local_target(target: &str) -> bool {
    target.starts_with('/')
        && !target.starts_with("//")
        && !target.bytes().any(|byte| byte.is_ascii_control())
}

fn pair_response(cookie: &str, destination: &str, secure: bool) -> String {
    // HttpOnly keeps the credential out of any script the harness happens to
    // run; SameSite=Lax keeps another site from steering the phone into using
    // it. Public HTTPS gets Secure; LAN HTTP cannot send Secure cookies back.
    let secure = if secure { "; Secure" } else { "" };
    format!(
        "HTTP/1.1 303 See Other\r\n\
         Location: {destination}\r\n\
         Set-Cookie: {COOKIE}={cookie}; Path=/; Max-Age={COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax{secure}\r\n\
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
    use std::net::SocketAddr;

    fn decide(head: &Head, access: &Access) -> Decision {
        decide_for(head, access, &Audience::Lan)
    }

    #[test]
    fn public_origins_require_https_and_a_bare_authority() {
        assert!(Audience::https("https://example.test/").is_ok());
        for url in [
            "http://example.test",
            "https://user@example.test",
            "https://example.test/path",
            "https://example.test/?secret=hidden",
            "https://example.test/#fragment",
            "not a URL",
        ] {
            let error = Audience::https(url).unwrap_err().to_string();
            assert!(!error.contains(url));
        }
    }

    #[test]
    fn pending_and_wrong_public_origins_do_not_spend_pairing_codes() {
        let (access, code) = waiting();
        let audience = Audience::https("https://public.example.test").unwrap();
        let request = head(&format!(
            "GET /?k={code} HTTP/1.1\r\nHost: public.example.test\r\n\r\n"
        ));
        assert!(matches!(
            decide_for(&request, &access, &Audience::Pending),
            Decision::Refuse
        ));
        for headers in [
            "Host: different.example.test\r\n",
            "Host: public.example.test\r\nOrigin: http://public.example.test\r\n",
            "Host: public.example.test\r\nOrigin: https://other.example.test\r\n",
            "Host: public.example.test\r\nOrigin: https://public.example.test:444\r\n",
            "Host: public.example.test\r\nSec-Fetch-Site: same-site\r\n",
            "Host: other\r\nX-Forwarded-Host: public.example.test\r\nX-Forwarded-Proto: https\r\n",
            "Host: public.example.test\r\nHost: other\r\n",
            "X-Forwarded-Host: public.example.test\r\n",
        ] {
            let request = head(&format!("GET /?k={code} HTTP/1.1\r\n{headers}\r\n"));
            assert!(matches!(
                decide_for(&request, &access, &audience),
                Decision::Refuse
            ));
            assert!(access.pairing().is_some());
        }
        assert!(matches!(
            decide_for(&request, &access, &audience),
            Decision::Pair { .. }
        ));
    }

    #[test]
    fn public_same_origin_websocket_is_authenticated_and_cookie_is_secure() {
        let (access, code) = waiting();
        let audience = Audience::https("https://public.example.test").unwrap();
        let credential = access.pair(&code, "test browser").unwrap();
        let request = head(&format!("GET /api/remote.mux HTTP/1.1\r\nHost: public.example.test\r\nOrigin: https://public.example.test\r\nCookie: {COOKIE}={credential}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
        assert!(matches!(
            decide_for(&request, &access, &audience),
            Decision::Forward { .. }
        ));
        let public = pair_response(&credential, "/", true);
        assert!(public.contains("HttpOnly; SameSite=Lax; Secure\r\n"));
        assert!(!pair_response(&credential, "/", false).contains("; Secure"));
    }

    #[test]
    fn refuses_cross_origin_requests_before_spending_pairing_codes() {
        let (access, code) = waiting();
        for headers in [
            "Origin: http://other\r\n",
            "Origin: http://phone:9000\r\n",
            "Origin: null\r\n",
            "Sec-Fetch-Site: cross-site\r\n",
            "Sec-Fetch-Site: same-site\r\n",
            "Origin: http://phone\r\nOrigin: http://other\r\n",
        ] {
            let request = head(&format!(
                "GET /?k={code} HTTP/1.1\r\nHost: phone\r\n{headers}\r\n"
            ));
            assert!(matches!(decide(&request, &access), Decision::Refuse));
            assert!(
                access.pairing().is_some(),
                "rejected request spent the code"
            );
        }
        let request = head(&format!("GET /?k={code} HTTP/1.1\r\nHost: phone\r\nOrigin: http://phone\r\nSec-Fetch-Site: same-origin\r\n\r\n"));
        assert!(matches!(decide(&request, &access), Decision::Pair { .. }));
    }

    #[test]
    fn substitutes_upstream_credentials_and_closes_ordinary_http_connections() {
        let request = head("GET /api/session HTTP/1.1\r\nHost: phone\r\nCookie: dsh_studio_remote=phone-secret\r\nConnection: keep-alive\r\n\r\n");
        let upstream = Upstream {
            address: "127.0.0.1:3456".parse().expect("addr"),
            cookie: Some("dsh-auth-test=upstream-secret".into()),
        };
        let text = String::from_utf8(request.rewritten(&upstream)).expect("utf8");
        assert!(text.contains("Cookie: dsh-auth-test=upstream-secret\r\n"));
        assert!(!text.contains("phone-secret"));
        assert!(!text.contains("keep-alive"));
        assert!(text.contains("Connection: close\r\n"));
    }

    #[test]
    fn websocket_upgrade_retains_its_authenticated_duplex_transport() {
        let request = head("GET /ws HTTP/1.1\r\nHost: phone\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: test\r\n\r\n");
        let upstream = Upstream {
            address: "127.0.0.1:3456".parse().expect("addr"),
            cookie: Some("auth=secret".into()),
        };
        let text = String::from_utf8(request.rewritten(&upstream)).expect("utf8");
        assert!(text.contains("Connection: Upgrade\r\n"));
        assert!(text.contains("Cookie: auth=secret\r\n"));
        assert!(text.contains("Sec-WebSocket-Key: test\r\n"));
        assert!(!text.contains("Connection: close"));
    }

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
    fn pairing_redirects_never_leave_the_local_gateway() {
        let ordinary = head("GET /work?k=code&tab=1 HTTP/1.1\r\nHost: h\r\n\r\n");
        assert_eq!(ordinary.path_without_code(), "/work?tab=1");

        let external = head("GET //example.com/?k=code HTTP/1.1\r\nHost: h\r\n\r\n");
        assert_eq!(external.path_without_code(), "/");
    }

    #[test]
    fn request_head_limit_includes_the_terminating_blank_line() {
        let mut exact = vec![b'x'; MAX_HEAD - 4];
        exact.extend_from_slice(b"\r\n\r\n");
        assert_eq!(bounded_head_end(&exact), Ok(Some(MAX_HEAD - 4)));

        let mut oversized = vec![b'x'; MAX_HEAD - 3];
        oversized.extend_from_slice(b"\r\n\r\n");
        assert_eq!(bounded_head_end(&oversized), Err(()));
    }

    #[test]
    fn connection_limit_fails_closed_without_waiting() {
        let permits = Arc::new(Semaphore::new(1));
        let held = connection_permit(&permits).expect("first connection");
        assert!(connection_permit(&permits).is_none());
        drop(held);
        assert!(connection_permit(&permits).is_some());
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
        let rewritten = String::from_utf8(request.rewritten(&upstream.into())).expect("utf-8");

        assert!(rewritten.contains("Host: 127.0.0.1:41234"));
        assert!(rewritten.contains("Origin: http://127.0.0.1:41234"));
        assert!(rewritten.contains("Accept: */*"), "other headers survive");
        assert!(rewritten.ends_with("\r\n\r\n"));
    }

    #[test]
    fn carries_body_bytes_that_arrived_with_the_head() {
        let request = head("POST /m HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nhello");
        let upstream: SocketAddr = "127.0.0.1:1".parse().expect("addr");
        let rewritten = request.rewritten(&upstream.into());
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

    #[tokio::test]
    async fn public_gateway_waits_for_origin_then_pairs_and_relays_only_that_host() {
        let upstream = echoing_upstream().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let door = listener.local_addr().unwrap();
        let (access, code) = waiting();
        let shutdown = broadcast::channel(1).0;
        let (audience, receiver) = watch::channel(Audience::Pending);
        let worker = tokio::spawn(serve_with_audience(
            listener,
            Arc::clone(&access),
            upstream,
            Arc::new(Counters::default()),
            shutdown.subscribe(),
            broadcast::channel(8).0,
            receiver,
        ));
        let pair = format!("GET /chat?k={code} HTTP/1.1\r\nHost: public.example.test\r\n\r\n");
        assert!(speak(door, &pair).await.starts_with("HTTP/1.1 401"));
        assert!(access.pairing().is_some());
        audience.send_replace(Audience::https("https://public.example.test").unwrap());
        let paired = speak(door, &pair).await;
        assert!(paired.starts_with("HTTP/1.1 303"));
        assert!(paired.contains("; Secure\r\n"));
        let credential = credential_in(&paired);
        let public_request = format!("GET /chat HTTP/1.1\r\nHost: public.example.test\r\nOrigin: https://public.example.test\r\nCookie: {COOKIE}={credential}\r\n\r\n");
        assert!(speak(door, &public_request)
            .await
            .starts_with("HTTP/1.1 200"));
        let wrong_host =
            public_request.replace("Host: public.example.test", "Host: other.example.test");
        assert!(speak(door, &wrong_host).await.starts_with("HTTP/1.1 401"));
        let device = access.admit(&credential).unwrap();
        access.forget(&device);
        assert!(speak(door, &public_request)
            .await
            .starts_with("HTTP/1.1 401"));
        drop(shutdown);
        tokio::time::timeout(Duration::from_secs(2), worker)
            .await
            .unwrap()
            .unwrap();
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
        let (arrived, received) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = silent.accept().await.expect("upstream connection");
            let mut byte = [0u8; 1];
            assert_eq!(socket.read(&mut byte).await.expect("request byte"), 1);
            let _ = arrived.send(());
            let _ = tokio::io::copy(&mut socket, &mut tokio::io::sink()).await;
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
        tokio::time::timeout(Duration::from_secs(5), received)
            .await
            .expect("upstream received request")
            .expect("upstream task");
        assert_eq!(counters.active.load(Ordering::Relaxed), 1, "relaying");

        assert!(access.forget(&device));

        let mut byte = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_secs(5), phone.read(&mut byte)).await;
        assert!(
            matches!(read, Ok(Ok(0))),
            "the socket should have closed with the credential, got {read:?}"
        );
    }

    #[tokio::test]
    async fn revocation_between_admission_and_upstream_setup_forwards_nothing() {
        let upstream = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let door = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let _phone = TcpStream::connect(door.local_addr().expect("addr"))
            .await
            .expect("connect");
        let (mut inbound, _) = door.accept().await.expect("accept");
        let (access, code) = waiting();
        let held = access.pair(&code, "").expect("pairs");
        let request = head(&format!(
            "POST /action HTTP/1.1\r\nHost: phone\r\nCookie: {COOKIE}={held}\r\nContent-Length: 0\r\n\r\n"
        ));
        let mut revocations = access.watch_revocations();
        let Decision::Forward { device } = decide(&request, &access) else {
            panic!("paired device should be admitted");
        };
        assert!(access.forget(&device));
        tokio::time::timeout(
            Duration::from_secs(1),
            forward(
                &mut inbound,
                &request,
                &upstream.local_addr().expect("addr").into(),
                &device,
                &mut revocations,
            ),
        )
        .await
        .expect("revocation cancels setup");
        assert!(
            tokio::time::timeout(Duration::from_millis(50), upstream.accept())
                .await
                .is_err(),
            "a revoked device must not open an upstream connection"
        );
    }

    #[tokio::test]
    async fn closing_access_cancels_incomplete_headers_and_active_streams() {
        for authenticated in [false, true] {
            let upstream = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let mut phone = TcpStream::connect(listener.local_addr().expect("addr"))
                .await
                .expect("connect");
            let (inbound, _) = listener.accept().await.expect("accept");
            let (access, code) = waiting();
            let held = access.pair(&code, "").expect("pairs");
            let counters = Arc::new(Counters::default());
            let shutdown = broadcast::channel::<()>(1).0;
            let changed = broadcast::channel::<()>(8).0;
            let worker = tokio::spawn({
                let counters = Arc::clone(&counters);
                let closing = shutdown.subscribe();
                let address = upstream.local_addr().expect("addr");
                async move {
                    relay(
                        inbound,
                        access,
                        &address.into(),
                        counters,
                        closing,
                        &changed,
                        &Audience::Lan,
                    )
                    .await
                }
            });
            let request = if authenticated {
                format!("GET /events HTTP/1.1\r\nHost: phone\r\nCookie: {COOKIE}={held}\r\n\r\n")
            } else {
                "GET /events HTTP/1.1\r\nHost:".into()
            };
            phone.write_all(request.as_bytes()).await.expect("write");
            let mut upstream_socket = None;
            if authenticated {
                let (mut socket, _) =
                    tokio::time::timeout(Duration::from_secs(5), upstream.accept())
                        .await
                        .expect("upstream connected")
                        .expect("accept");
                let mut byte = [0u8; 1];
                tokio::time::timeout(Duration::from_secs(5), socket.read_exact(&mut byte))
                    .await
                    .expect("upstream received request")
                    .expect("read");
                assert_eq!(counters.active.load(Ordering::Relaxed), 1);
                upstream_socket = Some(socket);
            }
            drop(shutdown);
            tokio::time::timeout(Duration::from_secs(1), worker)
                .await
                .expect("closing cancels all relay phases")
                .expect("relay task");
            assert_eq!(counters.active.load(Ordering::Relaxed), 0);
            let mut byte = [0u8; 1];
            let read = tokio::time::timeout(Duration::from_secs(1), phone.read(&mut byte))
                .await
                .expect("phone disconnected");
            assert!(matches!(read, Ok(0) | Err(_)), "unexpected data: {read:?}");
            drop(upstream_socket);
        }
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

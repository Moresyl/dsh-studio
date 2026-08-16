//! Reaching the harness from a phone, without the harness leaving loopback.
//!
//! The service binds `127.0.0.1` and takes its port from the kernel, and that
//! does not change when remote access is switched on. What changes is that a
//! second listener appears on one LAN address, holding one secret generated at
//! that moment, and relays what it can authenticate to the loopback port. Turn
//! it off and the listener is gone along with the secret; the harness never
//! knew either way.
//!
//! Three things follow from that shape, and they are the reason for it:
//!
//! - The secret lives in memory for exactly as long as the door is open. There
//!   is no stored password to leak, reuse, or forget to change.
//! - The listener is bound to a single address, not to every interface, so a
//!   VPN or a hypervisor's virtual switch does not quietly become a second way
//!   in.
//! - Closing the door drops the sender every task is waiting on, so in-flight
//!   connections end with it rather than outliving the setting that allowed
//!   them.

pub mod commands;
pub mod gateway;
pub mod lan;
pub mod qr;

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

use crate::error::{Error, Result};
use gateway::Counters;

/// 128 bits from the operating system. Long enough that guessing it over a
/// network is not a strategy, short enough to stay in a small QR symbol.
const TOKEN_BYTES: usize = 16;

/// What the remote panel renders.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub open: bool,
    /// Addresses this machine could be reached on. Present whether or not the
    /// door is open, so the panel can say what would happen before it happens.
    pub addresses: Vec<String>,
    /// Where the harness is reachable, without the secret in it.
    pub url: Option<String>,
    /// The one URL that pairs a device, secret included. Never logged.
    pub pairing_url: Option<String>,
    /// The pairing URL as a module grid, for the panel to draw.
    pub qr: Option<qr::Matrix>,
    pub active: u32,
    pub served: u64,
    pub refused: u64,
}

/// One open door, or none.
struct Session {
    token: Arc<String>,
    host: Ipv4Addr,
    port: u16,
    counters: Arc<Counters>,
    /// Dropping this closes the door: every task in the gateway is waiting on a
    /// receiver derived from it, so there is no separate stop to forget.
    _shutdown: broadcast::Sender<()>,
}

/// Owns whether the harness is reachable from anywhere but this machine.
pub struct Remote {
    session: Mutex<Option<Session>>,
    changed: broadcast::Sender<()>,
}

impl Default for Remote {
    fn default() -> Self {
        Self::new()
    }
}

impl Remote {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            changed: broadcast::channel(16).0,
        }
    }

    /// Fires whenever a connection opens or closes, so the panel's counters can
    /// follow traffic instead of polling for it.
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changed.subscribe()
    }

    pub fn is_open(&self) -> bool {
        self.session
            .lock()
            .expect("remote session poisoned")
            .is_some()
    }

    /// Open the door in front of a harness already serving at `origin`.
    ///
    /// Calling this twice returns the door that is already open, secret and all,
    /// rather than rotating it — the QR code on screen has to keep working.
    pub async fn open(&self, origin: &str) -> Result<RemoteStatus> {
        if self.is_open() {
            return Ok(self.status());
        }

        let upstream = upstream_from(origin)?;
        let host = lan::best_address().ok_or(Error::RemoteNoNetwork)?;
        let listener = TcpListener::bind(SocketAddrV4::new(host, 0))
            .await
            .map_err(Error::RemoteBind)?;
        let port = listener.local_addr().map_err(Error::RemoteBind)?.port();

        let token = Arc::new(token()?);
        let counters = Arc::new(Counters::default());
        let shutdown = broadcast::channel::<()>(1).0;

        tokio::spawn(gateway::serve(
            listener,
            Arc::clone(&token),
            upstream,
            Arc::clone(&counters),
            // A receiver: the session below holds the only sender, so letting
            // go of the session is what stops every task the gateway spawns.
            shutdown.subscribe(),
            self.changed.clone(),
        ));

        // Storing replaces whatever was there, and dropping the old session
        // shuts its tasks down — so even the race two simultaneous callers could
        // win leaves exactly one door open.
        *self.session.lock().expect("remote session poisoned") = Some(Session {
            token,
            host,
            port,
            counters,
            _shutdown: shutdown,
        });
        let _ = self.changed.send(());

        Ok(self.status())
    }

    /// Close the door. Safe to call when it is already closed.
    pub fn close(&self) {
        let previous = self.session.lock().expect("remote session poisoned").take();
        if previous.is_some() {
            let _ = self.changed.send(());
        }
    }

    pub fn status(&self) -> RemoteStatus {
        let guard = self.session.lock().expect("remote session poisoned");

        let Some(session) = guard.as_ref() else {
            return RemoteStatus {
                open: false,
                addresses: lan::addresses()
                    .into_iter()
                    .map(|address| address.to_string())
                    .collect(),
                url: None,
                pairing_url: None,
                qr: None,
                active: 0,
                served: 0,
                refused: 0,
            };
        };

        let url = format!("http://{}:{}/", session.host, session.port);
        let pairing = format!("{url}?k={}", session.token);

        RemoteStatus {
            open: true,
            addresses: vec![session.host.to_string()],
            qr: qr::encode(&pairing),
            url: Some(url),
            pairing_url: Some(pairing),
            active: session.counters.active.load(Ordering::Relaxed),
            served: session.counters.served.load(Ordering::Relaxed),
            refused: session.counters.refused.load(Ordering::Relaxed),
        }
    }
}

/// A fresh pairing secret, as lowercase hex.
fn token() -> Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    // No fallback on purpose. A secret from a PRNG this code seeded itself
    // would be worse than refusing to open the door.
    getrandom::fill(&mut bytes).map_err(|_| Error::NoEntropy)?;

    let mut hex = String::with_capacity(TOKEN_BYTES * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

/// The loopback socket behind a serving origin.
///
/// The loopback check is not paranoia about our own code: it is the assertion
/// that makes this module safe to read. If the harness ever came up on a public
/// interface, relaying to it would compound the mistake instead of reporting it.
fn upstream_from(origin: &str) -> Result<SocketAddr> {
    let malformed = || {
        Error::Readiness(format!(
            "the harness is serving somewhere unusable: {origin}"
        ))
    };

    let url = url::Url::parse(origin).map_err(|_| malformed())?;
    let host = url.host_str().ok_or_else(malformed)?;
    let port = url.port_or_known_default().ok_or_else(malformed)?;
    let address: Ipv4Addr = host.parse().map_err(|_| malformed())?;

    if !address.is_loopback() {
        return Err(Error::Readiness(format!(
            "refusing to relay to {address}, which is not loopback"
        )));
    }
    Ok(SocketAddr::from((address, port)))
}

#[cfg(test)]
mod tests {
    use super::{token, upstream_from, Remote};

    #[test]
    fn a_token_is_128_bits_of_hex_and_never_repeats() {
        let first = token().expect("entropy");
        let second = token().expect("entropy");

        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn reads_the_loopback_socket_out_of_a_serving_origin() {
        let upstream = upstream_from("http://127.0.0.1:41234").expect("parses");
        assert_eq!(upstream.to_string(), "127.0.0.1:41234");
    }

    #[test]
    fn refuses_to_relay_anywhere_but_loopback() {
        assert!(upstream_from("http://192.168.1.5:3000").is_err());
        assert!(upstream_from("not a url").is_err());
    }

    #[test]
    fn starts_closed_and_says_nothing_secret() {
        let remote = Remote::new();
        let status = remote.status();

        assert!(!status.open);
        assert!(status.pairing_url.is_none());
        assert!(status.qr.is_none());
        assert_eq!(status.active, 0);
    }

    #[test]
    fn closing_a_closed_door_is_not_an_error() {
        let remote = Remote::new();
        remote.close();
        remote.close();
        assert!(!remote.is_open());
    }

    #[tokio::test]
    async fn opening_needs_a_harness_that_is_actually_serving() {
        let remote = Remote::new();
        assert!(remote.open("http://192.168.1.5:3000").await.is_err());
        assert!(!remote.is_open());
    }
}

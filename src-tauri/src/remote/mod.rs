//! Reaching the harness from a phone, without the harness leaving loopback.
//!
//! The service binds `127.0.0.1` and takes its port from the kernel, and that
//! does not change when remote access is switched on. What changes is that a
//! second listener appears on one LAN address, holding one secret generated at
//! that moment, and relays what it can authenticate to the loopback port. Turn
//! it off and the listener is gone along with the secret; the harness never
//! knew either way.
//!
//! Four things follow from that shape, and they are the reason for it:
//!
//! - Every secret lives in memory for exactly as long as the door is open.
//!   There is no stored password to leak, reuse, or forget to change.
//! - The listener is bound to a single address, not to every interface, so a
//!   VPN or a hypervisor's virtual switch does not quietly become a second way
//!   in.
//! - Closing the door drops the sender every task is waiting on, so in-flight
//!   connections end with it rather than outliving the setting that allowed
//!   them.
//! - What the QR symbol carries is not what a paired phone keeps. The code on
//!   screen is good for two minutes and for one device; each device that uses
//!   it gets a credential of its own, which can be revoked by itself. See
//!   [`access`] for why those are two different things.

pub mod access;
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
use access::{Access, DeviceView, CODE_LIFETIME};
use gateway::Counters;

const POISONED: &str = "remote session poisoned";

/// What the remote panel renders.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub open: bool,
    /// Addresses this machine could be reached on. Present whether or not the
    /// door is open, so the panel can say what would happen before it happens.
    pub addresses: Vec<String>,
    /// Where the harness is reachable, without any secret in it.
    pub url: Option<String>,
    /// The one URL that pairs a device, code included. Never logged.
    pub pairing_url: Option<String>,
    /// The pairing URL as a module grid, for the panel to draw.
    pub qr: Option<qr::Matrix>,
    /// Seconds the code on screen has left, or `None` when there is no live one
    /// — which is also when `qr` and `pairing_url` are absent.
    pub code_seconds_left: Option<u32>,
    /// How long a code gets. Sent rather than duplicated in the panel, which
    /// needs it to draw the part of the life that is left.
    pub code_lifetime_seconds: u32,
    /// Devices that have paired and have not been forgotten.
    pub devices: Vec<DeviceView>,
    pub active: u32,
    pub served: u64,
    pub refused: u64,
}

/// One open door, or none.
struct Session {
    access: Arc<Access>,
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
        self.session.lock().expect(POISONED).is_some()
    }

    /// Open the door in front of a harness already serving at `origin`.
    ///
    /// Calling this twice returns the door that is already open, credentials and
    /// all, rather than replacing it — the phones already paired through it have
    /// to keep working.
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

        let access = Arc::new(Access::open()?);
        let counters = Arc::new(Counters::default());
        let shutdown = broadcast::channel::<()>(1).0;

        tokio::spawn(gateway::serve(
            listener,
            Arc::clone(&access),
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
        *self.session.lock().expect(POISONED) = Some(Session {
            access,
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
        let previous = self.session.lock().expect(POISONED).take();
        if previous.is_some() {
            let _ = self.changed.send(());
        }
    }

    /// Put a new pairing code on screen, without disturbing the devices that
    /// paired through the last one.
    pub fn renew(&self) -> Result<RemoteStatus> {
        if let Some(access) = self.access() {
            access.renew()?;
            let _ = self.changed.send(());
        }
        Ok(self.status())
    }

    /// Forget one device: its next request is refused, and anything it has open
    /// right now ends.
    pub fn forget(&self, id: &str) -> RemoteStatus {
        if let Some(access) = self.access() {
            if access.forget(id) {
                let _ = self.changed.send(());
            }
        }
        self.status()
    }

    pub fn status(&self) -> RemoteStatus {
        let guard = self.session.lock().expect(POISONED);

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
                code_seconds_left: None,
                code_lifetime_seconds: CODE_LIFETIME.as_secs() as u32,
                devices: Vec::new(),
                active: 0,
                served: 0,
                refused: 0,
            };
        };

        let url = format!("http://{}:{}/", session.host, session.port);
        let live = session.access.pairing();
        let pairing = live.as_ref().map(|code| format!("{url}?k={}", code.code));

        RemoteStatus {
            open: true,
            addresses: vec![session.host.to_string()],
            qr: pairing.as_deref().and_then(qr::encode),
            code_seconds_left: live.as_ref().map(|code| code.seconds_left),
            code_lifetime_seconds: CODE_LIFETIME.as_secs() as u32,
            pairing_url: pairing,
            url: Some(url),
            devices: session.access.devices(),
            active: session.counters.active.load(Ordering::Relaxed),
            served: session.counters.served.load(Ordering::Relaxed),
            refused: session.counters.refused.load(Ordering::Relaxed),
        }
    }

    /// The credentials of the open door, if there is one.
    ///
    /// Handed out as an `Arc` rather than worked on under the lock, because
    /// every caller goes on to read [`Self::status`] — which takes the same
    /// lock, and would deadlock on a guard still held.
    fn access(&self) -> Option<Arc<Access>> {
        self.session
            .lock()
            .expect(POISONED)
            .as_ref()
            .map(|session| Arc::clone(&session.access))
    }
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
    use super::{upstream_from, Remote};

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
        assert!(status.code_seconds_left.is_none());
        assert!(status.devices.is_empty());
        assert_eq!(status.active, 0);
    }

    #[test]
    fn closing_a_closed_door_is_not_an_error() {
        let remote = Remote::new();
        remote.close();
        remote.close();
        assert!(!remote.is_open());
    }

    /// The panel can ask for either of these at any time — including while the
    /// door is shut, because a click can always land after a close.
    #[test]
    fn renewing_and_forgetting_on_a_closed_door_do_nothing() {
        let remote = Remote::new();

        let renewed = remote.renew().expect("not an error");
        assert!(renewed.code_seconds_left.is_none());
        assert!(remote.forget("whatever").devices.is_empty());
        assert!(!remote.is_open());
    }

    #[tokio::test]
    async fn opening_needs_a_harness_that_is_actually_serving() {
        let remote = Remote::new();
        assert!(remote.open("http://192.168.1.5:3000").await.is_err());
        assert!(!remote.is_open());
    }
}

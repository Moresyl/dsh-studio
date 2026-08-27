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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::{Error, Result};
use access::{Access, DeviceView, CODE_LIFETIME};
use gateway::Counters;

/// What the remote panel renders.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub open: bool,
    /// True while the Harness is restarting and the LAN door is being rebuilt.
    /// Paired devices are retained in memory during this short transition.
    pub suspended: bool,
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

/// The LAN listener is intentionally gone while Harness is unavailable, but a
/// transient restart must not make every phone pair again. The credential is
/// retained only in memory and is discarded by an explicit remote close.
struct Suspended {
    access: Arc<Access>,
    host: Ipv4Addr,
    port: u16,
    counters: Arc<Counters>,
}

/// Owns whether the harness is reachable from anywhere but this machine.
pub struct Remote {
    session: Mutex<Option<Session>>,
    suspended: Mutex<Option<Suspended>>,
    opening: AsyncMutex<()>,
    requested: AtomicBool,
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
            suspended: Mutex::new(None),
            opening: AsyncMutex::new(()),
            requested: AtomicBool::new(false),
            changed: broadcast::channel(16).0,
        }
    }

    /// Fires whenever a connection opens or closes, so the panel's counters can
    /// follow traffic instead of polling for it.
    pub fn subscribe(&self) -> broadcast::Receiver<()> {
        self.changed.subscribe()
    }

    pub fn is_open(&self) -> bool {
        self.session().is_some()
    }

    pub fn is_suspended(&self) -> bool {
        self.suspended().is_some()
    }

    /// Open the door in front of a harness already serving at `origin`.
    ///
    /// Calling this twice returns the door that is already open, credentials and
    /// all, rather than replacing it — the phones already paired through it have
    /// to keep working.
    pub async fn open(&self, origin: &str) -> Result<RemoteStatus> {
        self.requested.store(true, Ordering::Release);
        self.connect(origin).await
    }

    async fn connect(&self, origin: &str) -> Result<RemoteStatus> {
        let _opening = self.opening.lock().await;
        if !self.requested.load(Ordering::Acquire) {
            return Ok(self.status());
        }
        if self.is_open() {
            return Ok(self.status());
        }

        let suspended = self.suspended().take();
        let status = self.open_listener(origin, suspended.as_ref()).await;
        if status.is_err() {
            // A failed rebind must not throw away the phone credentials.
            if self.requested.load(Ordering::Acquire) {
                if let Some(suspended) = suspended {
                    *self.suspended() = Some(suspended);
                } else {
                    self.requested.store(false, Ordering::Release);
                }
            } else {
                // An explicit Close won the race with the failed rebind.
                // Dropping the captured state is the credential revocation.
            }
        }
        status
    }

    /// Rebuild a deliberately suspended door after Harness becomes ready.
    /// A remote session the user closed is not reopened by this path.
    pub async fn resume(&self, origin: &str) -> Result<RemoteStatus> {
        if !self.requested.load(Ordering::Acquire) || !self.is_suspended() {
            return Ok(self.status());
        }
        self.connect(origin).await
    }

    /// Temporarily remove the LAN listener while Harness is restarting.
    /// Explicit `close` remains the only operation that forgets devices.
    pub fn suspend(&self) {
        let Some(session) = self.session().take() else {
            return;
        };
        *self.suspended() = Some(Suspended {
            access: session.access,
            host: session.host,
            port: session.port,
            counters: session.counters,
        });
        let _ = self.changed.send(());
    }

    async fn open_listener(
        &self,
        origin: &str,
        suspended: Option<&Suspended>,
    ) -> Result<RemoteStatus> {
        let upstream = upstream_from(origin)?;
        let host = suspended
            .map(|state| state.host)
            .or_else(lan::best_address)
            .ok_or(Error::RemoteNoNetwork)?;
        let requested_port = suspended.map_or(0, |state| state.port);
        let listener = bind_listener(host, requested_port).await?;
        let port = listener.local_addr().map_err(Error::RemoteBind)?.port();

        let access = match suspended {
            Some(state) => Arc::clone(&state.access),
            None => Arc::new(Access::open()?),
        };
        let counters = suspended
            .map(|state| Arc::clone(&state.counters))
            .unwrap_or_else(|| Arc::new(Counters::default()));
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
        *self.session() = Some(Session {
            access,
            host,
            port,
            counters,
            _shutdown: shutdown,
        });
        if !self.requested.load(Ordering::Acquire) {
            self.session().take();
            return Ok(self.status());
        }
        let _ = self.changed.send(());

        Ok(self.status())
    }

    /// Close the door. Safe to call when it is already closed.
    pub fn close(&self) {
        self.requested.store(false, Ordering::Release);
        let previous = self.session().take();
        let suspended = self.suspended().take();
        if previous.is_some() || suspended.is_some() {
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
        let guard = self.session();
        let Some(session) = guard.as_ref() else {
            drop(guard);
            let suspended = self.suspended();
            let devices = suspended
                .as_ref()
                .map(|state| state.access.devices())
                .unwrap_or_default();
            let address = suspended
                .as_ref()
                .map(|state| state.host)
                .or_else(lan::best_address);
            let url = suspended
                .as_ref()
                .map(|state| format!("http://{}:{}/", state.host, state.port));
            return RemoteStatus {
                open: false,
                suspended: suspended.is_some(),
                addresses: address
                    .into_iter()
                    .map(|address| address.to_string())
                    .collect(),
                url,
                pairing_url: None,
                qr: None,
                code_seconds_left: None,
                code_lifetime_seconds: CODE_LIFETIME.as_secs() as u32,
                devices,
                active: 0,
                served: suspended
                    .as_ref()
                    .map_or(0, |state| state.counters.served.load(Ordering::Relaxed)),
                refused: suspended
                    .as_ref()
                    .map_or(0, |state| state.counters.refused.load(Ordering::Relaxed)),
            };
        };

        let url = format!("http://{}:{}/", session.host, session.port);
        let live = session.access.pairing();
        let pairing = live.as_ref().map(|code| format!("{url}?k={}", code.code));

        RemoteStatus {
            open: true,
            suspended: false,
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
        let live = self
            .session()
            .as_ref()
            .map(|session| Arc::clone(&session.access));
        live.or_else(|| {
            self.suspended()
                .as_ref()
                .map(|suspended| Arc::clone(&suspended.access))
        })
    }

    /// A poisoned session fails closed. Dropping it closes the listener and all
    /// relays; preserving a possibly half-mutated authentication door would be
    /// the less safe recovery policy.
    fn session(&self) -> MutexGuard<'_, Option<Session>> {
        match self.session.lock() {
            Ok(session) => session,
            Err(poisoned) => {
                let mut session = PoisonError::into_inner(poisoned);
                *session = None;
                self.session.clear_poison();
                session
            }
        }
    }

    fn suspended(&self) -> MutexGuard<'_, Option<Suspended>> {
        match self.suspended.lock() {
            Ok(suspended) => suspended,
            Err(poisoned) => {
                let mut suspended = PoisonError::into_inner(poisoned);
                *suspended = None;
                self.suspended.clear_poison();
                suspended
            }
        }
    }
}

/// Rebinding the same address is what lets a phone reconnect without learning a
/// new URL. The previous gateway exits asynchronously, so a resume gets a short
/// bounded retry window for the old listener to release its socket.
async fn bind_listener(host: Ipv4Addr, port: u16) -> Result<TcpListener> {
    const RETRIES: usize = 20;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

    let address = SocketAddrV4::new(host, port);
    let mut last = None;
    for attempt in 0..=if port == 0 { 0 } else { RETRIES } {
        match TcpListener::bind(address).await {
            Ok(listener) => return Ok(listener),
            Err(cause) => last = Some(cause),
        }
        if attempt < RETRIES {
            tokio::time::sleep(RETRY_DELAY).await;
        }
    }
    Err(Error::RemoteBind(last.expect("a bind attempt always ran")))
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
    use std::net::Ipv4Addr;
    use std::panic::{self, AssertUnwindSafe};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    use super::access::Access;
    use super::gateway::{self, Counters};
    use super::{upstream_from, Remote, Session};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::broadcast;

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
    fn poisoned_remote_session_fails_closed_without_cascading_panics() {
        let remote = Remote::new();
        let _ = panic::catch_unwind(AssertUnwindSafe(|| {
            let _held = remote.session.lock().expect("initial lock");
            panic!("poison remote session");
        }));

        assert!(!remote.is_open());
        assert!(!remote.status().open);
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

    #[test]
    fn transient_suspend_keeps_devices_and_explicit_close_forgets_them() {
        let remote = Remote::new();
        let access = Arc::new(Access::open().expect("entropy"));
        let code = access.pairing().expect("pairing code").code;
        assert!(access.pair(&code, "iPhone Safari").is_some());
        let shutdown = broadcast::channel::<()>(1).0;

        *remote.session() = Some(Session {
            access,
            host: Ipv4Addr::new(192, 168, 1, 5),
            port: 43123,
            counters: Arc::new(Counters::default()),
            _shutdown: shutdown,
        });

        remote.suspend();
        let paused = remote.status();
        assert!(!paused.open);
        assert!(paused.suspended);
        assert_eq!(paused.url.as_deref(), Some("http://192.168.1.5:43123/"));
        assert_eq!(paused.devices.len(), 1);

        remote.close();
        let closed = remote.status();
        assert!(!closed.open);
        assert!(!closed.suspended);
        assert!(closed.devices.is_empty());
    }

    async fn echoing_upstream(mark: &'static str) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind upstream");
        let address = listener.local_addr().expect("upstream address");
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0u8; 2048];
                let _ = socket.read(&mut request).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{mark}",
                    mark.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        address
    }

    async fn request(address: std::net::SocketAddr, credential: &str) -> String {
        let mut socket = TcpStream::connect(address).await.expect("connect gateway");
        socket
            .write_all(
                format!(
                    "GET / HTTP/1.1\r\nHost: phone\r\nCookie: dsh_studio_remote={credential}\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("write request");
        let mut response = String::new();
        socket
            .read_to_string(&mut response)
            .await
            .expect("read response");
        response
    }

    #[tokio::test]
    async fn resume_reuses_the_url_and_device_credential_with_a_new_upstream() {
        let first_upstream = echoing_upstream("first").await;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind gateway");
        let address = listener.local_addr().expect("gateway address");
        let access = Arc::new(Access::open().expect("entropy"));
        let code = access.pairing().expect("pairing").code;
        let credential = access.pair(&code, "iPhone Safari").expect("paired");
        let counters = Arc::new(Counters::default());
        let shutdown = broadcast::channel::<()>(1).0;
        let remote = Remote::new();
        remote.requested.store(true, Ordering::Release);

        tokio::spawn(gateway::serve(
            listener,
            Arc::clone(&access),
            first_upstream,
            Arc::clone(&counters),
            shutdown.subscribe(),
            remote.changed.clone(),
        ));
        *remote.session() = Some(Session {
            access,
            host: Ipv4Addr::LOCALHOST,
            port: address.port(),
            counters,
            _shutdown: shutdown,
        });
        assert!(request(address, &credential).await.ends_with("first"));

        remote.suspend();
        let second_upstream = echoing_upstream("second").await;
        remote
            .resume(&format!("http://{second_upstream}"))
            .await
            .expect("resume");

        assert_eq!(remote.status().url, Some(format!("http://{address}/")));
        assert!(request(address, &credential).await.ends_with("second"));
        remote.close();
    }

    #[tokio::test]
    async fn opening_needs_a_harness_that_is_actually_serving() {
        let remote = Remote::new();
        assert!(remote.open("http://192.168.1.5:3000").await.is_err());
        assert!(!remote.is_open());
    }
}

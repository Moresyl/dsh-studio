//! Who is allowed through the door.
//!
//! Two credentials, with deliberately different lifetimes.
//!
//! The **pairing code** is the one the QR symbol carries. A code on a screen can
//! be read by any camera pointed at the room and by anyone standing behind the
//! person holding the phone, and it is worth a whole session to whoever reads
//! it — so it lives for two minutes and stops working the first time it is used.
//! A photograph of the screen is worth nothing by the time anyone looks at it.
//!
//! A **device credential** is what a paired phone keeps afterwards. One per
//! device, minted at the moment of pairing, which buys two things: a phone that
//! was lent out or lost can be forgotten without turning the other devices away,
//! and the code that travelled over the network in the clear is not the thing
//! presented on every later request.
//!
//! Nothing here is written to disk. Closing the door drops the whole structure,
//! codes and devices together.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::broadcast;

use crate::error::{Error, Result};

/// How long a pairing code stays usable.
///
/// Long enough to open the pane, pick up a phone and unlock it; short enough
/// that a code left on screen over lunch is not still a way in.
pub const CODE_LIFETIME: Duration = Duration::from_secs(120);

/// 128 bits from the operating system, for every secret here.
const SECRET_BYTES: usize = 16;

/// Separates a device's id from its secret inside the cookie.
const COOKIE_SEPARATOR: char = '.';

const POISONED: &str = "remote access poisoned";

/// The credentials one open door will accept.
pub struct Access {
    state: Mutex<State>,
    /// Fires with the id of a device that has just been forgotten, so relays
    /// belonging to it can end rather than outlive the credential that allowed
    /// them. A revoke button that leaves a live socket streaming has not
    /// revoked anything.
    revoked: broadcast::Sender<String>,
}

struct State {
    code: Option<Code>,
    devices: Vec<Device>,
}

/// The pairing code currently on screen.
struct Code {
    secret: String,
    /// Stored as the deadline rather than the birthday, so nothing has to
    /// subtract from an `Instant` that may be younger than the lifetime.
    expires: Instant,
}

struct Device {
    /// Names the device in the cookie and in the panel. Not a secret — it is
    /// random only so that nothing can be enumerated by counting.
    id: String,
    secret: String,
    label: Option<String>,
    paired: Instant,
    seen: Instant,
}

/// The live pairing code, and how long it has left.
pub struct Pairing {
    pub code: String,
    pub seconds_left: u32,
}

/// One paired device, as the panel lists it.
///
/// Relative ages rather than timestamps: the panel would have to know this
/// machine's clock and time zone to render an absolute one, and every question
/// a person asks of this list — is that still my old phone? did I pair that
/// today? — is a question about how long ago.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    /// What the device called itself, or `None` when it said nothing useful.
    pub label: Option<String>,
    pub paired_seconds_ago: u64,
    pub last_seen_seconds_ago: u64,
}

impl Access {
    /// A door that has just opened: one live pairing code, no devices yet.
    pub fn open() -> Result<Self> {
        Ok(Self {
            state: Mutex::new(State {
                code: Some(Code::mint()?),
                devices: Vec::new(),
            }),
            revoked: broadcast::channel(16).0,
        })
    }

    /// Put a new pairing code on screen, whatever became of the last one.
    ///
    /// Paired devices are untouched. This replaces the thing the QR symbol
    /// carries, not the credentials it has already handed out.
    pub fn renew(&self) -> Result<()> {
        let code = Code::mint()?;
        self.state.lock().expect(POISONED).code = Some(code);
        Ok(())
    }

    /// The code the panel should show, or `None` once it has been used or has
    /// run out of time.
    pub fn pairing(&self) -> Option<Pairing> {
        let state = self.state.lock().expect(POISONED);
        let code = state.code.as_ref()?;
        Some(Pairing {
            code: code.secret.clone(),
            seconds_left: code.seconds_left()?,
        })
    }

    /// Exchange a pairing code for a credential of this device's own.
    ///
    /// Returns the cookie value to hand back, or `None` if the code was wrong,
    /// spent, or out of time — the three of which are deliberately one answer.
    pub fn pair(&self, offered: &str, agent: &str) -> Option<String> {
        let mut state = self.state.lock().expect(POISONED);

        let code = state.code.as_ref()?;
        if code.seconds_left().is_none() || !constant_time_eq(offered.as_bytes(), &code.secret) {
            // A wrong guess deliberately does not spend the code. It is 128
            // bits; guessing is not a strategy, and a code that died on a wrong
            // guess would let anyone on the network stop the pairing.
            return None;
        }

        let device = Device::mint(agent).ok()?;
        let cookie = format!("{}{COOKIE_SEPARATOR}{}", device.id, device.secret);
        state.code = None;
        state.devices.push(device);
        Some(cookie)
    }

    /// The device a cookie names, if this door still knows it.
    ///
    /// Marks it seen on the way through, which is what lets the panel show a
    /// list of phones rather than a list of pairings.
    pub fn admit(&self, cookie: &str) -> Option<String> {
        let (id, secret) = cookie.split_once(COOKIE_SEPARATOR)?;
        let mut state = self.state.lock().expect(POISONED);

        let device = state.devices.iter_mut().find(|device| device.id == id)?;
        if !constant_time_eq(secret.as_bytes(), &device.secret) {
            return None;
        }
        device.seen = Instant::now();
        Some(device.id.clone())
    }

    /// Forget one device, so its next request is refused like a stranger's and
    /// anything it has open right now ends.
    ///
    /// Answers whether there was anything to forget, so a caller can tell a
    /// revocation from a repeated click.
    pub fn forget(&self, id: &str) -> bool {
        let mut state = self.state.lock().expect(POISONED);
        let before = state.devices.len();
        state.devices.retain(|device| device.id != id);

        if state.devices.len() == before {
            return false;
        }
        let _ = self.revoked.send(id.to_string());
        true
    }

    pub fn devices(&self) -> Vec<DeviceView> {
        self.state
            .lock()
            .expect(POISONED)
            .devices
            .iter()
            .map(Device::view)
            .collect()
    }

    /// Follow revocations, for a relay that has to end when its device does.
    pub fn watch_revocations(&self) -> broadcast::Receiver<String> {
        self.revoked.subscribe()
    }

    /// Make the code lapse without waiting two minutes for it.
    #[cfg(test)]
    fn lapse(&self) {
        if let Some(code) = self.state.lock().expect(POISONED).code.as_mut() {
            code.expires = Instant::now();
        }
    }
}

impl Code {
    fn mint() -> Result<Self> {
        Ok(Self {
            secret: secret()?,
            expires: Instant::now() + CODE_LIFETIME,
        })
    }

    /// Whole seconds remaining, or `None` once there are none — so that "is it
    /// still good?" and "what do I show?" cannot answer differently.
    fn seconds_left(&self) -> Option<u32> {
        let left = self.expires.saturating_duration_since(Instant::now());
        (!left.is_zero()).then_some(left.as_secs() as u32)
    }
}

impl Device {
    fn mint(agent: &str) -> Result<Self> {
        let now = Instant::now();
        Ok(Self {
            id: secret()?,
            secret: secret()?,
            label: describe(agent),
            paired: now,
            seen: now,
        })
    }

    fn view(&self) -> DeviceView {
        DeviceView {
            id: self.id.clone(),
            label: self.label.clone(),
            paired_seconds_ago: self.paired.elapsed().as_secs(),
            last_seen_seconds_ago: self.seen.elapsed().as_secs(),
        }
    }
}

/// What a device called itself, cut down to the two facts that tell two devices
/// apart.
///
/// A user agent string is a paragraph of compatibility history — the phone in
/// question claims to be Mozilla, KHTML and Gecko before it gets round to being
/// an iPhone. The only question a person asks of a list of paired devices is
/// which phone each row is, so that is all that is kept.
fn describe(agent: &str) -> Option<String> {
    let platform = first_match(agent, &PLATFORMS);
    let browser = first_match(agent, &BROWSERS);

    match (platform, browser) {
        (Some(platform), Some(browser)) => Some(format!("{platform} · {browser}")),
        (Some(only), None) | (None, Some(only)) => Some(only.to_string()),
        (None, None) => None,
    }
}

fn first_match(agent: &str, table: &[(&str, &'static str)]) -> Option<&'static str> {
    table
        .iter()
        .find(|(needle, _)| agent.contains(needle))
        .map(|(_, name)| *name)
}

/// Ordered, and the order is the point: every browser claims to be several
/// others further along its user agent string, so the specific claim has to be
/// tested before the compatibility one. Android before Linux, Edge before
/// Chrome, Chrome before Safari.
const PLATFORMS: [(&str, &str); 7] = [
    ("iPhone", "iPhone"),
    ("iPad", "iPad"),
    ("Android", "Android"),
    ("CrOS", "ChromeOS"),
    ("Macintosh", "Mac"),
    ("Windows", "Windows"),
    ("Linux", "Linux"),
];

const BROWSERS: [(&str, &str); 7] = [
    ("SamsungBrowser", "Samsung Internet"),
    ("Edg", "Edge"),
    ("OPR", "Opera"),
    ("Firefox", "Firefox"),
    ("CriOS", "Chrome"),
    ("Chrome", "Chrome"),
    ("Safari", "Safari"),
];

/// A fresh 128-bit secret, as lowercase hex.
fn secret() -> Result<String> {
    let mut bytes = [0u8; SECRET_BYTES];
    // No fallback on purpose. A secret from a PRNG this code seeded itself
    // would be worse than refusing to open the door.
    getrandom::fill(&mut bytes).map_err(|_| Error::NoEntropy)?;

    let mut hex = String::with_capacity(SECRET_BYTES * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

/// Compare without leaking, through timing, how much of a guess was right.
fn constant_time_eq(left: &[u8], right: &str) -> bool {
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> Access {
        Access::open().expect("the test machine has entropy")
    }

    fn code_of(access: &Access) -> String {
        access.pairing().expect("a fresh door shows a code").code
    }

    #[test]
    fn a_fresh_door_shows_one_live_code_and_knows_nobody() {
        let access = open();
        let pairing = access.pairing().expect("a code");

        assert_eq!(pairing.code.len(), SECRET_BYTES * 2);
        assert!(pairing.code.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(pairing.seconds_left <= CODE_LIFETIME.as_secs() as u32);
        assert!(access.devices().is_empty());
    }

    #[test]
    fn pairing_spends_the_code() {
        let access = open();
        let code = code_of(&access);

        assert!(access.pair(&code, "").is_some());
        assert!(
            access.pairing().is_none(),
            "the code is gone once it worked"
        );
        assert!(
            access.pair(&code, "").is_none(),
            "and the same code cannot be used twice"
        );
    }

    #[test]
    fn a_wrong_code_pairs_nothing_and_leaves_the_right_one_alone() {
        let access = open();
        let code = code_of(&access);

        assert!(access.pair("0".repeat(code.len()).as_str(), "").is_none());
        assert!(
            access.pairing().is_some(),
            "a stranger's guess must not be able to stop the pairing"
        );
        assert!(access.pair(&code, "").is_some());
    }

    #[test]
    fn a_lapsed_code_is_not_a_credential() {
        let access = open();
        let code = code_of(&access);
        access.lapse();

        assert!(access.pairing().is_none(), "nothing to show any more");
        assert!(access.pair(&code, "").is_none());
    }

    #[test]
    fn admits_only_the_credential_it_minted() {
        let access = open();
        let code = code_of(&access);
        let cookie = access.pair(&code, "").expect("pairs");

        assert!(access.admit(&cookie).is_some());
        assert!(access.admit(&code).is_none(), "the code is not the cookie");
        assert!(access.admit("nonsense").is_none());

        let (id, _) = cookie.split_once('.').expect("id and secret");
        assert!(
            access
                .admit(&format!("{id}.{}", "0".repeat(SECRET_BYTES * 2)))
                .is_none(),
            "the right device with the wrong secret is still a stranger"
        );
    }

    #[test]
    fn two_devices_get_two_credentials() {
        let access = open();
        let first = access.pair(&code_of(&access), "").expect("pairs");
        access.renew().expect("entropy");
        let second = access.pair(&code_of(&access), "").expect("pairs again");

        assert_ne!(first, second);
        assert_eq!(access.devices().len(), 2);
        assert!(access.admit(&first).is_some());
        assert!(access.admit(&second).is_some());
    }

    #[test]
    fn forgetting_one_device_turns_only_that_one_away() {
        let access = open();
        let kept = access.pair(&code_of(&access), "").expect("pairs");
        access.renew().expect("entropy");
        let lost = access.pair(&code_of(&access), "").expect("pairs again");

        let id = access.admit(&lost).expect("known before it is forgotten");
        assert!(access.forget(&id));
        assert!(!access.forget(&id), "there is nothing left to forget");

        assert!(access.admit(&lost).is_none());
        assert!(access.admit(&kept).is_some());
        assert_eq!(access.devices().len(), 1);
    }

    #[test]
    fn a_revocation_reaches_the_relays() {
        let access = open();
        let mut watching = access.watch_revocations();
        let cookie = access.pair(&code_of(&access), "").expect("pairs");
        let id = access.admit(&cookie).expect("known");

        assert!(access.forget(&id));
        assert_eq!(watching.try_recv().ok().as_deref(), Some(id.as_str()));
    }

    #[test]
    fn describes_a_device_by_what_tells_it_apart() {
        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) \
                      AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
        assert_eq!(describe(iphone).as_deref(), Some("iPhone · Safari"));

        let android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 \
                       (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
        assert_eq!(
            describe(android).as_deref(),
            Some("Android · Chrome"),
            "Android wins over the Linux it also claims, Chrome over the Safari"
        );

        let edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                    (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
        assert_eq!(describe(edge).as_deref(), Some("Windows · Edge"));

        assert_eq!(describe("").as_deref(), None, "nothing invented");
    }

    #[test]
    fn compares_in_constant_time_without_being_wrong() {
        assert!(constant_time_eq(b"abc", "abc"));
        assert!(!constant_time_eq(b"abc", "abd"));
        assert!(!constant_time_eq(b"abc", "ab"));
    }
}

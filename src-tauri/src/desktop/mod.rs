//! The desktop, offered to whatever the harness is running.
//!
//! A plugin the user installs runs as a page inside the harness, and a page
//! cannot do the four things that make a desktop application worth having: say
//! something while nobody is looking at the window, ask for a file by its real
//! path, put a count where the window is not, or be opened by a link from
//! somewhere else. This is the interface that lends those four out.
//!
//! Deliberately four and not forty. The shell can run shell commands; the point
//! of a narrow interface is that everything it grants can be read in one sitting,
//! and everything it does not grant is not a decision anybody has to re-derive.
//! Growing it is a version bump, which is why the version is in the handshake.
//!
//! The trust boundary is the origin. Requests are taken from the harness's own
//! origin and from nowhere else — not from a page it frames from the internet,
//! and not at all while nothing is serving. That check lives in the shell's
//! frontend, next to the frame it applies to; see `src/lib/bridge.ts`.

pub mod badge;
pub mod commands;

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, UserAttentionType, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;
use url::Url;

use crate::error::{Error, Result};
use crate::window;

/// The interface's own version, carried in every handshake.
///
/// One number for the whole surface rather than one per capability: a plugin
/// author has to be able to answer "will this work" before writing the call.
const PROTOCOL: u32 = 3;

/// The scheme this app answers to. Registered by the installer, and at runtime
/// in a development build where no installer has run.
const SCHEME: &str = "dsh";

/// Channel the shell listens on for links that arrive while it is running.
const LINK_CHANNEL: &str = "desktop://link";

/// A notification is a whole system's attention, so it is not a place to paste a
/// log. Anything longer is cut rather than refused — a truncated message still
/// says what happened, and a refusal says nothing at all.
const TITLE_LIMIT: usize = 120;
const BODY_LIMIT: usize = 400;

/// The script every frame of this window gets before its own scripts run.
///
/// Injected rather than published as a package to install: a plugin author who
/// has to add a dependency to find out whether the desktop is there will not
/// bother, and `window.dshStudio` being either present or absent is the whole
/// feature detection story.
const CLIENT: &str = include_str!("client.js");

/// What the desktop is holding for whoever asks first.
#[derive(Default)]
pub struct Desk {
    /// The last link that arrived. Kept because the thing that wants it may not
    /// exist yet: a link can start the app, and the harness takes seconds to come
    /// up after that.
    pending: Mutex<Option<Link>>,
}

/// A `dsh://` link, already taken apart.
///
/// Handing over the raw string as well as the pieces is deliberate: the pieces
/// are what a plugin switches on, and the string is what it logs when none of
/// the pieces were what it expected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub url: String,
    /// Host and path as one path, with the slashes trimmed: `profile/lab`.
    ///
    /// A URL's split between the two is an accident of how many slashes were
    /// typed, and no plugin author should have to know which side of it they are
    /// on.
    pub route: String,
    pub query: BTreeMap<String, String>,
}

impl Link {
    /// Read a link the way a route is read, not the way a URL is parsed.
    pub fn read(url: &Url) -> Self {
        let host = url.host_str().unwrap_or_default().trim_matches('/');
        let path = url.path().trim_matches('/');

        let route = match (host.is_empty(), path.is_empty()) {
            (true, _) => path.to_string(),
            (false, true) => host.to_string(),
            (false, false) => format!("{host}/{path}"),
        };

        Link {
            url: url.as_str().to_string(),
            route,
            query: url
                .query_pairs()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        }
    }
}

/// What the shell tells a frame about the desktop it is running on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub protocol: u32,
    pub app: String,
    pub version: String,
    pub platform: String,
    /// The URL scheme that reaches this app from anywhere on the machine.
    pub scheme: String,
    pub capabilities: Vec<&'static str>,
    /// A link that arrived before there was anything to hand it to, if one did.
    pub link: Option<Link>,
}

/// Describe the desktop, and hand over any link that was waiting for a listener.
///
/// Taken rather than copied: a link is an instruction to do something once, and
/// a copy left behind would be carried out again by the next frame to load.
pub fn offer<R: Runtime>(app: &AppHandle<R>) -> Offer {
    Offer {
        protocol: PROTOCOL,
        app: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.to_string(),
        scheme: SCHEME.to_string(),
        capabilities: vec![
            "notify",
            "pick",
            "badge",
            "link",
            "profiles",
            "plugins",
            "workspace",
        ],
        link: app
            .try_state::<Desk>()
            .and_then(|desk| desk.pending.lock().ok()?.take()),
    }
}

/// Say something the window does not have to be open to hear.
pub fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) -> Result<()> {
    app.notification()
        .builder()
        .title(clip(title, TITLE_LIMIT))
        .body(clip(body, BODY_LIMIT))
        .show()
        .map_err(|error| Error::Desktop(error.to_string()))
}

/// Generic background attention, suppressed while this window has focus.
pub fn attention<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    kind: &str,
) -> Result<()> {
    if window.is_focused().unwrap_or(false) {
        return Ok(());
    }
    let (title, body, attention) = match kind {
        "job-completed" => (
            crate::locale::pick("Background job completed", "后台任务已完成"),
            crate::locale::pick("A background job has finished.", "有一个后台任务已经结束。"),
            crate::startup::Attention::JobCompleted,
        ),
        "job-failed" => (
            crate::locale::pick("Background job needs attention", "后台任务需要处理"),
            crate::locale::pick("A background job has failed.", "有一个后台任务执行失败。"),
            crate::startup::Attention::JobFailed,
        ),
        _ => {
            return Err(Error::Desktop(
                "the desktop attention kind is not supported".into(),
            ))
        }
    };
    if !crate::startup::attention_enabled(attention) {
        return Ok(());
    }
    notify(app, title, body)?;
    let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    Ok(())
}

/// Put a count where the window is not.
///
/// Three places, because no two desktops agree on where a badge belongs: the
/// tray, which every platform has; the taskbar button on Windows, which takes a
/// picture; and the dock or launcher elsewhere, which takes the number itself and
/// draws it in the system's own hand.
pub fn mark<R: Runtime>(app: &AppHandle<R>, count: u32) {
    crate::tray::badge(app, count);

    // One taskbar button carries the mark, even where there are several windows:
    // the count is the harness's and not any one window's, and stamping it on
    // every button would read as that many things waiting rather than one.
    let Some(main) = window::front(app) else {
        return;
    };

    #[cfg(windows)]
    let _ = main.set_overlay_icon(badge::alone(count));

    #[cfg(not(windows))]
    let _ = main.set_badge_count((count > 0).then(|| i64::from(count)));
}

/// Take the first `limit` characters, never the first `limit` bytes.
fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// Start answering `dsh://` links.
///
/// Two paths reach here and both end in the same place. On macOS the system
/// hands the URL to the running app; on Windows and Linux it starts the app
/// again with the URL as an argument, and the single-instance plugin folds that
/// launch into the one already running — see the `deep-link` feature in
/// `Cargo.toml`, without which the fold would swallow the link.
pub fn wire(app: &AppHandle) {
    // Nothing has registered the scheme in a development build, because
    // registering it is the installer's job. Pointed at the binary that is
    // running, so a `dsh://` link opens the build being worked on.
    #[cfg(debug_assertions)]
    let _ = app.deep_link().register_all();

    // A link that started the app arrives before anything is listening for it.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in &urls {
            hold(app, Link::read(url));
        }
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            arrive(&handle, Link::read(&url));
        }
    });
}

/// A link that arrived while the app is up: show the window and pass it on.
fn arrive(app: &AppHandle, link: Link) {
    if let Some(main) = window::front(app) {
        // Whatever the link asks for, it was asked for by somebody who is at this
        // machine right now. Answering it behind a hidden window would look like
        // the link did nothing.
        window::reveal(&main);
    }

    // Held as well as emitted: the shell forwards it to the frame if one is
    // loaded, and a frame that loads a moment later finds it in the handshake.
    hold(app, link.clone());
    let _ = app.emit(LINK_CHANNEL, link);
}

fn hold<R: Runtime>(app: &AppHandle<R>, link: Link) {
    if let Some(desk) = app.try_state::<Desk>() {
        if let Ok(mut pending) = desk.pending.lock() {
            *pending = Some(link);
        }
    }
}

/// The client script, with the protocol version compiled into it.
///
/// The script is plain JavaScript in a file of its own rather than a string in
/// this one, because it is a program: it deserves to be read, edited and tested
/// as one. `src/lib/bridge.test.ts` runs this exact text.
pub fn client() -> String {
    CLIENT.replace("__DSH_PROTOCOL__", &PROTOCOL.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(raw: &str) -> Link {
        Link::read(&Url::parse(raw).expect("a parseable link"))
    }

    /// The shape a plugin author switches on. Host and path are one route here,
    /// because which of the two a segment lands in depends only on how many
    /// slashes somebody typed.
    #[test]
    fn a_link_is_read_as_a_route_and_its_arguments() {
        let link = read("dsh://profile/lab?restart=1&from=cli");

        assert_eq!(link.route, "profile/lab");
        assert_eq!(link.query["restart"], "1");
        assert_eq!(link.query["from"], "cli");
        assert_eq!(link.url, "dsh://profile/lab?restart=1&from=cli");
    }

    /// Both spellings of the same instruction have to read the same, because
    /// both are what people type.
    #[test]
    fn the_number_of_slashes_is_not_part_of_the_route() {
        assert_eq!(read("dsh://open").route, "open");
        assert_eq!(read("dsh:open").route, "open");
        assert_eq!(read("dsh://open/").route, "open");
    }

    /// A bare scheme is a link too — "come to the front" is a whole instruction.
    #[test]
    fn a_link_with_nothing_in_it_still_reads() {
        assert_eq!(read("dsh://").route, "");
        assert!(read("dsh://").query.is_empty());
    }

    /// Percent-encoding is how a route argument carries a path or a space, and a
    /// plugin should never have to undo it twice.
    #[test]
    fn arguments_arrive_decoded() {
        let link = read("dsh://plugin/install?name=%40scope%2Fthing&note=two%20words");

        assert_eq!(link.query["name"], "@scope/thing");
        assert_eq!(link.query["note"], "two words");
    }

    /// A notification is not a log viewer. Cut on character boundaries, because
    /// cutting bytes out of a multi-byte character is how a title becomes a
    /// question mark.
    #[test]
    fn long_notification_text_is_cut_rather_than_refused() {
        assert_eq!(clip("短", 4), "短");
        assert_eq!(clip(&"检查".repeat(80), 4), "检查检查");
        assert_eq!(clip(&"x".repeat(500), BODY_LIMIT).len(), BODY_LIMIT);
    }

    /// The version is compiled in rather than duplicated, so the handshake and
    /// the client can never disagree about which protocol this is.
    #[test]
    fn the_client_script_carries_the_protocol_version() {
        let script = client();

        assert!(!script.contains("__DSH_PROTOCOL__"), "placeholder left in");
        assert!(script.contains(&PROTOCOL.to_string()));
        assert!(script.contains("__DSH_DESKTOP_PICK_DIRECTORY__"));
        assert!(script.contains("workspace-drop"));
    }
}

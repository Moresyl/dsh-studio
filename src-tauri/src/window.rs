//! The application window and the chrome it wears on each platform.
//!
//! The window is built in Rust rather than declared in `tauri.conf.json` so the
//! platform differences below can be expressed as code. They are not cosmetic
//! preferences: each platform has one arrangement that reads as native, and
//! picking the wrong one is what makes a cross-platform app feel ported.
//!
//! There can be more than one. A second window is not a second application —
//! the supervisor, the profile stack and the shelf of sessions all stay single,
//! and every window is a view onto the same ones. What a window owns is what
//! somebody is doing in it, which is exactly what a person running two tasks
//! through one agent needs a second of.
//!
//! Only the first is what the rest of this codebase means by "the window": it is
//! the one that is put away rather than closed while the harness runs, and the
//! only one whose size and position are written down between runs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, Theme, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::error::{Error, Result};
use crate::material::{self, Material};
use crate::paths;
use crate::startup;

/// Label every other module uses to find the window.
pub const MAIN_LABEL: &str = "main";

/// What the windows after the first are called: `work-2`, `work-3`, and so on.
///
/// Numbered from two because the number is also what the window calls itself in
/// its own title bar, and the first window is the first window.
///
/// The prefix is load-bearing outside this file: `capabilities/default.json`
/// grants its permissions to `main` and `work-*`, and a window whose label
/// matched neither would be handed a webview that is not allowed to close it.
const WORK_PREFIX: &str = "work-";

/// How many windows one harness is worth being spread across.
///
/// Not a licence: the twelfth window costs exactly what the second did. The
/// number is here because a held-down shortcut opens windows faster than a
/// person can close them, and every one of them is a whole webview.
const CEILING: usize = 12;

/// How far a new window sits from the one it was opened from, in logical pixels.
const CASCADE: f64 = 30.0;

/// What every window is called before its number is added.
const TITLE: &str = "DSH Studio";

const DEFAULT_WIDTH: f64 = 1360.0;
const DEFAULT_HEIGHT: f64 = 880.0;

/// Below this the sidebar and the transcript stop coexisting.
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 620.0;

/// How long the frontend gets to reveal the window before Rust does it anyway.
const REVEAL_DEADLINE: Duration = Duration::from_secs(4);

/// How long a drag or a resize has to stop before the result is written down.
///
/// A resize is hundreds of events. This is the pause that turns them into one
/// file write, and it is short enough that a window closed straight after being
/// moved has still recorded where it went.
const SETTLE: Duration = Duration::from_millis(600);

/// Create the main window, hidden.
///
/// The frontend reveals it once it has painted, so the first thing a user sees
/// is the application rather than a white rectangle.
pub fn build<R: tauri::Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<WebviewWindow<R>> {
    // Asked once, before the builder, because two of its arguments depend on the
    // answer: a window is only made transparent where something will be drawn
    // behind it, and the frontend has to know which of its grounds are glass
    // before it paints the first one.
    let material = material::supported();
    // Asked here for the same reason: the frontend reveals the window itself
    // once it has painted, so it has to know before it paints that this launch
    // is one nobody is watching.
    let standby = startup::standby();

    let window = shell(manager, MAIN_LABEL.to_string(), material, standby)
        .title(TITLE)
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .center()
        .build()?;

    dress(&window, material);

    // While it is still hidden, so the window is only ever seen where the user
    // left it — never centred first and then jumping.
    restore(&window);
    remember(&window);

    // Standing by is the one launch where nothing appearing is the correct
    // outcome, so there is no deadline to rescue: the tray is already there, and
    // it is what the user will reach for.
    if !standby {
        rescue(&window);
        crate::recovery::watch(&window);
    }

    Ok(window)
}

/// Open another window onto the same harness.
///
/// Everything a window points at is shared — one supervisor, one profile, one
/// shelf of sessions — so nothing here is a second copy of anything. What it
/// creates is a second place to work, and the harness loaded into it is a fresh
/// page: two windows are two conversations, which is the entire reason to want
/// the second one.
///
/// Deliberately not the first window twice over. Where it lands is not written
/// down, because `window.json` records where the user keeps *their* window and a
/// window opened for one task should not move it. And it closes when it is
/// asked to rather than hiding, because the tray already has one window to put
/// the application away into and does not need three.
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    from: Option<&WebviewWindow<R>>,
) -> Result<WebviewWindow<R>> {
    let ordinal = vacancy(&app.webview_windows()).ok_or_else(|| {
        Error::Window(format!(
            "{CEILING} windows are open already, which is as many as this app will run at once"
        ))
    })?;

    let material = material::supported();
    let (width, height) = size_of(from);

    // Never standing by: a window nobody asked for is the login item's, and this
    // one was asked for by somebody who just pressed a key.
    let window = shell(app, label(ordinal), material, false)
        .title(format!("{TITLE} — {ordinal}"))
        .inner_size(width, height)
        .center()
        .build()
        .map_err(|cause| Error::Window(format!("the window could not be opened: {cause}")))?;

    dress(&window, material);
    if let Some(from) = from {
        cascade(&window, from);
    }
    rescue(&window);
    crate::recovery::watch(&window);

    Ok(window)
}

/// Open another window, from whichever one asked for it.
///
/// Async because it has to be: on Windows a webview built from inside a
/// synchronous command deadlocks against the event loop that is waiting for that
/// command to return — see the note on `WebviewWindowBuilder::new`.
#[tauri::command]
pub async fn window_open(app: AppHandle, window: WebviewWindow) -> Result<()> {
    open(&app, Some(&window)).map(drop)
}

/// The lowest number no window is using, or nothing once the ceiling is reached.
///
/// The lowest rather than the next one, so closing the third window and opening
/// another gives the third window back instead of counting on forever. The
/// number is on screen, and a user who has two windows open should not be
/// looking at one labelled nine.
fn vacancy<T>(taken: &HashMap<String, T>) -> Option<usize> {
    (2..=CEILING).find(|ordinal| !taken.contains_key(&label(*ordinal)))
}

fn label(ordinal: usize) -> String {
    format!("{WORK_PREFIX}{ordinal}")
}

/// The builder every window in this application starts from.
///
/// One function rather than a copy per window, because this chrome is what makes
/// the app an application instead of a browser: a second window that kept the
/// system title bar, or that missed the script the harness frame is spoken to
/// through, would be a different program wearing the same icon.
fn shell<'a, R: Runtime, M: Manager<R>>(
    manager: &'a M,
    label: String,
    material: Option<Material>,
    standby: bool,
) -> WebviewWindowBuilder<'a, R, M> {
    let builder = WebviewWindowBuilder::new(manager, label, WebviewUrl::default())
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .transparent(material.is_some())
        .initialization_script(announce(material, standby))
        // Every frame and not just the top one: the shell's own document is the
        // top frame, and everything the desktop interface exists for runs below
        // it — the harness, and the plugin pages the harness frames in turn.
        .initialization_script_for_all_frames(crate::desktop::client())
        .visible(false);

    // macOS keeps its traffic lights and floats them over the content, which is
    // what every native app there does.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // Windows and Linux get no system title bar at all; the shell draws its own,
    // which is the only way to get one consistent look across both.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    builder
}

/// Put the backdrop behind a window that has just been built.
///
/// After the window exists rather than on the builder, because the material
/// carries the frame's light-or-dark with it and the system's answer to that is
/// only readable from a window. The frontend replaces this as soon as it has
/// read what was chosen last time; the window is still hidden here, so there is
/// no frame in which either one is seen being wrong.
fn dress<R: Runtime>(window: &WebviewWindow<R>, material: Option<Material>) {
    if let Some(material) = material {
        let dark = !matches!(window.theme(), Ok(Theme::Light));
        material::apply(window, material, dark);
    }
}

/// Show the window anyway, if the frontend never gets round to it.
///
/// Hiding a window until the frontend paints is only a safe trade if a frontend
/// that never paints still leaves something on screen to report the problem in.
/// Otherwise the app would simply appear not to launch.
fn rescue<R: Runtime>(window: &WebviewWindow<R>) {
    let fallback = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_DEADLINE).await;
        if let Ok(false) = fallback.is_visible() {
            let _ = fallback.show();
        }
    });
}

/// How big a new window opens: the size of the one it was opened from.
///
/// Somebody who has sized a window to their screen has already answered this
/// question, and answering it again with a default would make the second window
/// read as belonging to a different application. A maximized window is the
/// exception — its size is the display's, and a new window that filled the
/// display would bury the one that asked for it.
fn size_of<R: Runtime>(from: Option<&WebviewWindow<R>>) -> (f64, f64) {
    let default = (DEFAULT_WIDTH, DEFAULT_HEIGHT);
    let Some(from) = from else {
        return default;
    };

    if from.is_maximized().unwrap_or(false) {
        return default;
    }

    let (Ok(size), Ok(scale)) = (from.inner_size(), from.scale_factor()) else {
        return default;
    };
    let logical = size.to_logical::<f64>(scale);

    (logical.width, logical.height)
}

/// Put a new window down beside the one it was opened from.
///
/// Cascading rather than centring: a centred second window lands exactly on top
/// of the first, and two windows sharing one rectangle look like one window that
/// swallowed the work in the other.
fn cascade<R: Runtime>(window: &WebviewWindow<R>, from: &WebviewWindow<R>) {
    let (Ok(origin), Ok(size), Ok(scale)) = (
        from.outer_position(),
        window.outer_size(),
        from.scale_factor(),
    ) else {
        return;
    };

    let step = (CASCADE * scale) as i32;
    let placement = Placement {
        x: origin.x + step,
        y: origin.y + step,
        width: size.width,
        height: size.height,
        maximized: false,
    };

    // Off the end of the display it was cascading towards. The centred position
    // the window already has is the safe answer, and it is the same one
    // `restore` falls back to for the same reason.
    if on_screen(window, &placement) {
        let _ = window.set_position(PhysicalPosition::new(placement.x, placement.y));
    }
}

/// Tell the frontend what kind of window it is in, before it paints.
///
/// An initialization script and not a command, because the difference matters
/// once: the grounds a translucent window paints are not the ones an opaque
/// window paints, and asking over IPC would mean a frame of the wrong answer
/// before the right one arrives. This runs before the page's own scripts, so the
/// stylesheet is already correct at the first paint — and, for the same reason,
/// a window that is meant to stay hidden is never briefly shown.
fn announce(material: Option<Material>, standby: bool) -> String {
    let value = serde_json::to_string(&material).unwrap_or_else(|_| "null".to_string());
    format!("window.__DSH_MATERIAL__ = {value};window.__DSH_STANDBY__ = {standby};")
}

/// Bring an existing window back to the front.
///
/// Used when a second launch is folded into the running instance.
pub fn reveal<R: tauri::Runtime>(window: &WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// The window a request from outside the application should land on.
///
/// The first one while it is still there: the tray, a second launch and a
/// `dsh://` link all mean "bring the application back", and that is the window
/// the application is built around. But it can be closed while another window
/// keeps the process alive, and then any window is a better answer than none —
/// the alternative is a tray icon whose Open does nothing at all.
pub fn front<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_LABEL)
        .or_else(|| app.webview_windows().into_values().next())
}

/// Where the window was and how big, in physical pixels.
///
/// Physical rather than logical because that is what both the window and the
/// monitor list report, and comparing the two is the whole point: a position
/// saved on a second monitor has to be recognisable as off-screen once that
/// monitor is gone.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn placement_file() -> PathBuf {
    paths::app_data_dir().join("window.json")
}

/// Put the window back where it was left.
///
/// Everything here is best effort by design. A window that opens centred is a
/// minor disappointment; an application that refuses to start because it could
/// not read a convenience file is a bug.
fn restore<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(placement) = read_placement() else {
        return;
    };

    // A window restored onto a monitor that is no longer there is a window the
    // user cannot reach. The centred default is the safe answer.
    if on_screen(window, &placement) {
        let _ = window.set_position(PhysicalPosition::new(placement.x, placement.y));
        let _ = window.set_size(PhysicalSize::new(placement.width, placement.height));
    }

    if placement.maximized {
        let _ = window.maximize();
    }
}

/// Keep writing down where the window is for as long as it is open.
///
/// A maximized window records only that it was maximized: its size is the
/// screen's, and restoring that as the un-maximized size would leave someone who
/// un-maximizes with a window that fills the display anyway.
fn remember<R: Runtime>(window: &WebviewWindow<R>) {
    let Some(initial) = current_placement(window) else {
        return;
    };

    let tracker = Arc::new(Tracker {
        latest: Mutex::new(initial),
        scheduled: AtomicBool::new(false),
    });
    let watched = window.clone();

    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }
        // Minimizing is a resize to something that is not a window shape.
        if watched.is_minimized().unwrap_or(false) {
            return;
        }

        let maximized = watched.is_maximized().unwrap_or(false);
        // Poisoned only if a previous handler panicked while holding it, and
        // then the recorded position is the least of the problems.
        let Ok(mut latest) = tracker.latest.lock() else {
            return;
        };
        latest.maximized = maximized;
        if !maximized {
            if let Some(fresh) = current_placement(&watched) {
                *latest = Placement {
                    maximized: false,
                    ..fresh
                };
            }
        }
        drop(latest);

        // One write per gesture rather than one per event: whoever gets here
        // first books the flush, and everyone else has already updated the value
        // that flush will read.
        if tracker.scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let pending = Arc::clone(&tracker);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(SETTLE).await;
            pending.scheduled.store(false, Ordering::SeqCst);
            if let Ok(latest) = pending.latest.lock() {
                write_placement(&latest);
            }
        });
    });
}

struct Tracker {
    latest: Mutex<Placement>,
    /// Whether a write is already queued for the gesture in progress.
    scheduled: AtomicBool,
}

fn current_placement<R: Runtime>(window: &WebviewWindow<R>) -> Option<Placement> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;

    Some(Placement {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    })
}

/// Whether the strip the window is dragged by lands on a monitor that exists.
///
/// The test is the top edge and not the whole rectangle: a window may hang off
/// the bottom or the side of a display and still be perfectly usable, but one
/// whose title bar is off-screen cannot be moved back.
fn on_screen<R: Runtime>(window: &WebviewWindow<R>, placement: &Placement) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };

    let grip_x = placement.x + i32::try_from(placement.width / 2).unwrap_or(0);
    let grip_y = placement.y + TITLE_BAR_DEPTH;

    monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        let right = origin.x + i32::try_from(size.width).unwrap_or(i32::MAX);
        let bottom = origin.y + i32::try_from(size.height).unwrap_or(i32::MAX);

        (origin.x..right).contains(&grip_x) && (origin.y..bottom).contains(&grip_y)
    })
}

/// Physical pixels into the window where the drag strip is, at 100% scaling.
const TITLE_BAR_DEPTH: i32 = 18;

/// No file on the first launch, and a corrupt one is no worse than none.
fn read_placement() -> Option<Placement> {
    let raw = std::fs::read(placement_file()).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn write_placement(placement: &Placement) {
    let path = placement_file();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_vec(placement) {
        let _ = std::fs::write(path, raw);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Labels of windows that are open, as `webview_windows` reports them.
    fn open(labels: &[&str]) -> HashMap<String, ()> {
        labels
            .iter()
            .map(|label| ((*label).to_string(), ()))
            .collect()
    }

    /// Two windows cannot share a label — the second build fails — so the number
    /// the first window does not use is where the numbered run has to start.
    #[test]
    fn no_numbered_window_can_be_called_the_main_one() {
        assert!((2..=CEILING).all(|ordinal| label(ordinal) != MAIN_LABEL));
        assert_eq!(vacancy(&open(&[MAIN_LABEL])), Some(2));
    }

    /// The gap gets filled before the end is extended. Somebody with two windows
    /// open should not be looking at one that calls itself the ninth.
    #[test]
    fn a_new_window_takes_the_lowest_free_number() {
        assert_eq!(vacancy(&open(&[MAIN_LABEL, "work-2"])), Some(3));
        assert_eq!(vacancy(&open(&[MAIN_LABEL, "work-2", "work-3"])), Some(4));
        // Window three was closed; the next one is three again, not five.
        assert_eq!(vacancy(&open(&[MAIN_LABEL, "work-2", "work-4"])), Some(3));
    }

    /// A held-down shortcut asks for windows faster than anyone can close them,
    /// and every one of them is a whole webview with the harness loaded in it.
    #[test]
    fn the_ceiling_is_a_ceiling() {
        let mut labels = vec![MAIN_LABEL.to_string()];
        labels.extend((2..=CEILING).map(label));
        let full: HashMap<String, ()> = labels.into_iter().map(|label| (label, ())).collect();

        assert_eq!(full.len(), CEILING);
        assert_eq!(vacancy(&full), None);
    }
}

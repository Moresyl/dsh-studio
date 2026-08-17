//! The application window and the chrome it wears on each platform.
//!
//! The window is built in Rust rather than declared in `tauri.conf.json` so the
//! platform differences below can be expressed as code. They are not cosmetic
//! preferences: each platform has one arrangement that reads as native, and
//! picking the wrong one is what makes a cross-platform app feel ported.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    Manager, PhysicalPosition, PhysicalSize, Runtime, Theme, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::material::{self, Material};
use crate::paths;
use crate::startup;

/// Label every other module uses to find the window.
pub const MAIN_LABEL: &str = "main";

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

    let builder = WebviewWindowBuilder::new(manager, MAIN_LABEL, WebviewUrl::default())
        .title("DSH Studio")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .center()
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

    let window = builder.build()?;

    // After the window exists rather than on the builder, because the material
    // carries the frame's light-or-dark with it and the system's answer to that
    // is only readable from a window. The frontend replaces this as soon as it
    // has read what was chosen last time; the window is still hidden here, so
    // there is no frame in which either one is seen being wrong.
    if let Some(material) = material {
        let dark = !matches!(window.theme(), Ok(Theme::Light));
        material::apply(&window, material, dark);
    }

    // While it is still hidden, so the window is only ever seen where the user
    // left it — never centred first and then jumping.
    restore(&window);
    remember(&window);

    // Hiding the window until the frontend paints is only a safe trade if a
    // frontend that never paints still leaves something on screen to report the
    // problem in. Otherwise the app would simply appear not to launch.
    //
    // Standing by is the one launch where nothing appearing is the correct
    // outcome, so there is no deadline to rescue: the tray is already there, and
    // it is what the user will reach for.
    if !standby {
        let fallback = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(REVEAL_DEADLINE).await;
            if let Ok(false) = fallback.is_visible() {
                let _ = fallback.show();
            }
        });
    }

    Ok(window)
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

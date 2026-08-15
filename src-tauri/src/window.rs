//! The application window and the chrome it wears on each platform.
//!
//! The window is built in Rust rather than declared in `tauri.conf.json` so the
//! platform differences below can be expressed as code. They are not cosmetic
//! preferences: each platform has one arrangement that reads as native, and
//! picking the wrong one is what makes a cross-platform app feel ported.

use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Label every other module uses to find the window.
pub const MAIN_LABEL: &str = "main";

const DEFAULT_WIDTH: f64 = 1360.0;
const DEFAULT_HEIGHT: f64 = 880.0;

/// Below this the sidebar and the transcript stop coexisting.
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 620.0;

/// How long the frontend gets to reveal the window before Rust does it anyway.
const REVEAL_DEADLINE: Duration = Duration::from_secs(4);

/// Create the main window, hidden.
///
/// The frontend reveals it once it has painted, so the first thing a user sees
/// is the application rather than a white rectangle.
pub fn build<R: tauri::Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<WebviewWindow<R>> {
    let builder = WebviewWindowBuilder::new(manager, MAIN_LABEL, WebviewUrl::default())
        .title("DSH Studio")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .center()
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

    // Hiding the window until the frontend paints is only a safe trade if a
    // frontend that never paints still leaves something on screen to report the
    // problem in. Otherwise the app would simply appear not to launch.
    let fallback = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_DEADLINE).await;
        if let Ok(false) = fallback.is_visible() {
            let _ = fallback.show();
        }
    });

    Ok(window)
}

/// Bring an existing window back to the front.
///
/// Used when a second launch is folded into the running instance.
pub fn reveal<R: tauri::Runtime>(window: &WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

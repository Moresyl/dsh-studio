//! The four calls the service interface is made of.
//!
//! Thin on purpose: everything a caller is allowed to ask for is decided in
//! `mod.rs`, and everything a frame is allowed to ask for is decided in
//! `src/lib/bridge.ts`. A command that made its own decisions would be a third
//! place to look.

use tauri::{AppHandle, WebviewWindow};

use crate::error::Result;

use super::Offer;

#[tauri::command]
pub fn desktop_offer(app: AppHandle) -> Offer {
    super::offer(&app)
}

/// Asynchronous because showing a notification is the system's work, not this
/// app's: it is a D-Bus round trip on Linux and a WinRT call on Windows, and
/// neither belongs on the thread that draws the window.
#[tauri::command]
pub async fn desktop_notify(app: AppHandle, title: String, body: String) -> Result<()> {
    super::notify(&app, &title, &body)
}

/// Used by the injected same-origin job observer, not part of the public API.
#[tauri::command]
pub async fn desktop_attention(app: AppHandle, window: WebviewWindow, kind: String) -> Result<()> {
    super::attention(&app, &window, &kind)
}

/// Asynchronous for the same reason, plus one of its own: the badge is drawn
/// pixel by pixel, and on a platform whose icon is 512 across that is real work.
#[tauri::command]
pub async fn desktop_badge(app: AppHandle, count: u32) {
    super::mark(&app, count);
}

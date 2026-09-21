//! Webview cookie hygiene for the loopback origins the app talks to.
//!
//! dsh mints a fresh, randomly-named auth cookie on `127.0.0.1` every time it
//! boots — one per app launch, per harness restart, per version switch — and
//! nothing retires the ones it replaced. Each is good for thirty days, and
//! cookies ignore ports, so the whole pile rides along on every request the
//! window makes, to the shell server and to the harness alike. Left alone it
//! outgrows whatever is reading it: the harness serves from a plain
//! `node:http` server, whose default request-header ceiling is 16 KiB, about
//! seventy of these.
//!
//! The pile is dead weight one boot later, so it is swept immediately before
//! each harness process is spawned: the previous session is gone, the next has
//! not been minted, and nothing is holding state that the sweep could take
//! away. That is the only moment it is safe, and it is also the only moment it
//! is needed — a Studio window left open for days restarts the harness many
//! times inside one process.

use tauri::{AppHandle, Manager};

/// Drop every cookie the app's webviews hold for a loopback host.
///
/// Best effort, and off the caller's thread: WebView2 deadlocks on a
/// synchronous cookie call from the main thread, and a boot has no reason to
/// wait on this. It finishes long before the new harness completes its token
/// exchange, which is the only thing that plants a cookie worth keeping.
pub fn sweep_loopback(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    std::thread::spawn(move || {
        let Ok(cookies) = window.cookies() else {
            return;
        };
        for cookie in cookies {
            let loopback = cookie
                .domain()
                .is_some_and(|domain| domain == crate::shell::ADDRESS || domain == "localhost");
            if loopback {
                let _ = window.delete_cookie(cookie);
            }
        }
    });
}

//! The tray entry.
//!
//! An agent session outlives glancing at something else, so the window is not
//! the only way to reach the app. The tray reports what the harness is doing
//! without one, and offers the two actions worth having when the window is not
//! in front: bring it back, or stop the service.
//!
//! It never becomes a second control panel. Anything that needs explaining —
//! a missing runtime, an install, a failure and its reason — opens the window,
//! because a tray menu is the wrong place to read.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, WindowEvent};

use crate::desktop::badge;
use crate::harness::commands::AppState;
use crate::harness::supervisor::{Status, Stream};
use crate::locale::pick;
use crate::window;

const OPEN: &str = "tray:open";
const TOGGLE: &str = "tray:toggle";
const QUIT: &str = "tray:quit";

/// What has to be reached again every time the status changes.
struct Handles<R: Runtime> {
    icon: TrayIcon<R>,
    toggle: MenuItem<R>,
    art: Option<Art>,
    /// What the harness asked to have counted here, if anything. Kept because
    /// the icon is redrawn on every status change and a count that vanished when
    /// the service restarted would be a count nobody could trust.
    count: AtomicU32,
}

/// The same mark twice: lit while the harness serves, muted while it does not.
///
/// Both are derived from the window icon at startup rather than shipped as
/// separate files, so the two can never drift apart when the brand changes.
struct Art {
    live: Image<'static>,
    idle: Image<'static>,
}

/// Add the tray entry and wire it to the supervisor.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(
        app,
        OPEN,
        pick("Open DSH Studio", "打开 DSH Studio"),
        true,
        None::<&str>,
    )?;
    let toggle = MenuItem::with_id(app, TOGGLE, label_for(&Status::Stopped), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, pick("Quit", "退出"), true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let art = app.default_window_icon().map(|base| Art {
        live: base.clone().to_owned(),
        idle: muted(base),
    });

    let builder = TrayIconBuilder::new()
        .menu(&menu)
        // Left click belongs to the window, not to a menu: the thing a user
        // wants from a tray icon nine times out of ten is the app back.
        .show_menu_on_left_click(false)
        .tooltip(tooltip_for(&Status::Stopped, 0))
        .on_menu_event(on_menu)
        .on_tray_icon_event(|icon, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_window(icon.app_handle());
            }
        });

    // Nothing is running yet at startup, so the muted mark is the honest one to
    // open with.
    let builder = match &art {
        Some(art) => builder.icon(art.idle.clone()),
        None => builder,
    };

    let icon = builder.build(app)?;
    app.manage(Handles {
        icon,
        toggle,
        art,
        count: AtomicU32::new(0),
    });
    hide_instead_of_quitting(app);
    Ok(())
}

/// Drain the colour out of an icon, keeping a trace of the original hue.
///
/// Fully grey would read as a second, different icon; this reads as the same one
/// turned off — which is what a stopped harness is. Derived at runtime instead of
/// drawn by hand because a second hand-drawn file is a second thing to forget.
fn muted(base: &Image<'_>) -> Image<'static> {
    let mut rgba = base.rgba().to_vec();

    for pixel in rgba.as_chunks_mut::<4>().0 {
        // Rec. 601 luma: green carries most of the perceived brightness, so a
        // flat channel average would wash the mark out rather than mute it.
        let luma =
            (u32::from(pixel[0]) * 299 + u32::from(pixel[1]) * 587 + u32::from(pixel[2]) * 114)
                / 1000;
        for channel in &mut pixel[..3] {
            *channel = ((luma * 4 + u32::from(*channel)) / 5) as u8;
        }
    }

    Image::new_owned(rgba, base.width(), base.height())
}

/// Closing the window while a session is live hides it rather than quitting.
///
/// This belongs to the tray and not to the window, because the tray is the only
/// thing that makes it survivable: it is both the way back and the way out. With
/// nothing running there is nothing to keep alive, so closing means what it says.
///
/// The title bar says which of the two it is about to do — see `window.hide` in
/// `src/lib/i18n.ts`. A window that disappears while a service it started keeps
/// running is the one surprise worth spending a tooltip on.
///
/// The first window only, and that is the difference between the first window
/// and the rest. The others are opened for one task and closed when it is done;
/// one that hid instead would have to be hunted back out of the tray just to be
/// got rid of.
fn hide_instead_of_quitting<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = app.get_webview_window(window::MAIN_LABEL) else {
        return;
    };

    let handle = app.clone();
    let hidden = main.clone();
    main.on_window_event(move |event| {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        if !harness_running(&handle) {
            return;
        }
        api.prevent_close();
        let _ = hidden.hide();
    });
}

fn harness_running<R: Runtime>(app: &AppHandle<R>) -> bool {
    running(&current(app))
}

/// What the supervisor is doing, for the paths that arrive without being told.
fn current<R: Runtime>(app: &AppHandle<R>) -> Status {
    app.try_state::<AppState>()
        .map(|state| state.supervisor.status())
        .unwrap_or(Status::Stopped)
}

/// Bring the tray in line with what the harness is actually doing.
///
/// Called from the same event stream the UI reads, so the two cannot disagree
/// about the state — there is one source and both render it.
pub fn sync<R: Runtime>(app: &AppHandle<R>, status: &Status) {
    let Some(handles) = app.try_state::<Handles<R>>() else {
        return;
    };
    let _ = handles.toggle.set_text(label_for(status));
    dress(&handles, status);
}

/// Put a count on the tray, or take it off again at zero.
///
/// The count belongs to whoever the harness is running — see `desktop::mark`,
/// which sets this and the taskbar's own badge together so the two agree.
pub fn badge<R: Runtime>(app: &AppHandle<R>, count: u32) {
    let Some(handles) = app.try_state::<Handles<R>>() else {
        return;
    };
    handles.count.store(count, Ordering::Relaxed);
    dress(&handles, &current(app));
}

/// Draw the icon and write the tooltip the status and the count call for.
///
/// One function for both, because they are one statement: an icon that says a
/// count is waiting and a tooltip that says something else is worse than either
/// alone.
fn dress<R: Runtime>(handles: &Handles<R>, status: &Status) {
    let count = handles.count.load(Ordering::Relaxed);
    let _ = handles.icon.set_tooltip(Some(tooltip_for(status, count)));

    if let Some(art) = &handles.art {
        let base = if running(status) {
            &art.live
        } else {
            &art.idle
        };
        let wanted = if count == 0 {
            base.clone()
        } else {
            badge::stamp(base, count)
        };
        let _ = handles.icon.set_icon(Some(wanted));
    }
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        OPEN => open_window(app),
        TOGGLE => toggle_harness(app),
        // Drops the app handle, which drops the supervisor, which closes the job
        // object the harness and its tools live in.
        QUIT => app.exit(0),
        _ => {}
    }
}

fn open_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(existing) = window::front(app) {
        window::reveal(&existing);
    }
}

fn toggle_harness<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let supervisor = Arc::clone(&state.supervisor);

    if running(&supervisor.status()) {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = handle.state::<AppState>();
            let _ = crate::harness::commands::stop_managed(&state).await;
        });
        return;
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        if let Err(failure) = crate::harness::commands::start_managed(&state).await {
            state.supervisor.note(Stream::Stderr, failure.to_string());
            open_window(&handle);
        }
    });
}

/// Starting and restarting both count: the harness is on its way up, and asking
/// for it again would only race the attempt already in flight.
fn running(status: &Status) -> bool {
    !matches!(status, Status::Stopped | Status::Failed { .. })
}

fn label_for(status: &Status) -> &'static str {
    if running(status) {
        pick("Stop harness", "停止 Harness")
    } else {
        pick("Start harness", "启动 Harness")
    }
}

/// Kept short: a tooltip is read at a glance, over a taskbar, at 11px.
///
/// The count is spelled out here because the badge cannot: the mark stops
/// counting at nine, and this is where the number itself lives.
fn tooltip_for(status: &Status, count: u32) -> String {
    let detail = match status {
        Status::Stopped => pick("not running", "未运行").to_string(),
        Status::Starting => pick("starting", "正在启动").to_string(),
        // The port is the one part worth carrying into a tooltip: it is what
        // someone needs to reach the service from anywhere else.
        Status::Ready { origin, .. } => pick("running on ", "运行于 ").to_string() + origin,
        Status::Restarting { attempt, .. } => {
            format!(
                "{}{attempt}",
                pick("reconnecting, attempt ", "正在重连，第 ")
            )
        }
        Status::Failed { .. } => pick("stopped on an error", "已因错误停止").to_string(),
    };

    match count {
        0 => format!("DSH Studio — {detail}"),
        _ => format!(
            "DSH Studio — {detail} · {count} {}",
            pick("waiting", "项待处理")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Status {
        Status::Ready {
            origin: "http://127.0.0.1:57652".into(),
            pid: 4242,
        }
    }

    /// The distinction the tray is built on. Everything that is not stopped or
    /// failed is on its way to serving, and asking for a start would only race
    /// the attempt already in flight.
    #[test]
    fn anything_short_of_stopped_or_failed_counts_as_running() {
        assert!(!running(&Status::Stopped));
        assert!(!running(&Status::Failed {
            reason: "no node".into()
        }));

        assert!(running(&Status::Starting));
        assert!(running(&ready()));
        assert!(running(&Status::Restarting {
            attempt: 2,
            delay_ms: 800
        }));
    }

    /// Closing the window must not be able to strand a live harness with no way
    /// back to it, so the two decisions have to be the same decision.
    #[test]
    fn the_toggle_label_and_the_close_behaviour_read_the_same_state() {
        for status in [Status::Starting, ready()] {
            assert_eq!(label_for(&status), pick("Stop harness", "停止 Harness"));
        }
        for status in [
            Status::Stopped,
            Status::Failed {
                reason: "exit 1".into(),
            },
        ] {
            assert_eq!(label_for(&status), pick("Start harness", "启动 Harness"));
        }
    }

    /// The port is the whole reason to hover the icon: it is what someone needs
    /// to reach the service from a terminal or another browser.
    #[test]
    fn a_running_tooltip_carries_the_origin() {
        let tooltip = tooltip_for(&ready(), 0);
        assert!(tooltip.contains("http://127.0.0.1:57652"), "{tooltip}");
        assert!(tooltip.starts_with("DSH Studio"), "{tooltip}");
    }

    /// The badge stops drawing at nine, so a tooltip that also stopped there
    /// would leave the exact number with nowhere to be read.
    #[test]
    fn the_tooltip_spells_out_a_count_the_badge_cannot() {
        assert!(!tooltip_for(&ready(), 0).contains('·'));

        let many = tooltip_for(&ready(), 42);
        assert!(many.contains("42"), "{many}");
        // Still the origin: a count is added to what the tooltip said, not
        // swapped in for it.
        assert!(many.contains("http://127.0.0.1:57652"), "{many}");
    }

    /// Muting has to leave the mark recognisable: same size, same silhouette,
    /// same transparency — only the colour goes.
    #[test]
    fn muting_only_takes_the_colour_out() {
        // A saturated blue pixel, a mid grey, and a transparent one.
        let source = Image::new_owned(
            vec![64, 128, 255, 255, 128, 128, 128, 255, 10, 200, 30, 0],
            3,
            1,
        );
        let dulled = muted(&source);

        assert_eq!(dulled.width(), source.width());
        assert_eq!(dulled.height(), source.height());

        let out = dulled.rgba();
        // Alpha is untouched, so the silhouette is identical.
        assert_eq!([out[3], out[7], out[11]], [255, 255, 0]);

        // The blue pixel loses most of its spread between channels…
        let spread = |p: &[u8]| {
            u32::from(p.iter().take(3).max().copied().unwrap_or(0))
                - u32::from(p.iter().take(3).min().copied().unwrap_or(0))
        };
        assert!(spread(&out[0..3]) < spread(&[64, 128, 255]) / 3);

        // …while something already grey comes through unchanged.
        assert_eq!(&out[4..7], &[128, 128, 128]);
    }

    /// A failure has a reason, and the reason is often a paragraph. It belongs
    /// in the window, not smeared across a tooltip.
    #[test]
    fn a_failure_tooltip_does_not_carry_the_reason() {
        let tooltip = tooltip_for(
            &Status::Failed {
                reason: "npm ERR! code ENOENT".into(),
            },
            0,
        );
        assert!(!tooltip.contains("ENOENT"), "{tooltip}");
    }
}

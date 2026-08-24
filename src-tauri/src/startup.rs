//! Being reachable when the window is not the thing in front.
//!
//! Two settings that are really one idea. A tool somebody returns to twenty
//! times a day should not have to be found again each time: logging in leaves it
//! standing by in the tray, and one key brings it forward from inside whatever
//! else is on screen.
//!
//! Both are off until asked for, and that is not timidity. A login item nobody
//! agreed to is the reason people distrust installers, and a global hotkey is
//! taken away from every other program on the machine — including the editor
//! that had it first. Neither is ours to assume.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt as _, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt as _;

use crate::error::{Error, Result};
use crate::paths;
use crate::window;

/// Offered when the shortcut is switched on, so nobody has to invent one.
///
/// `CmdOrCtrl` resolves to Command on macOS and Control everywhere else, the
/// same substitution the platform's own menus make. Two modifiers rather than
/// one, because a single-modifier combination is what an editor already has.
pub const SUGGESTED: &str = "CmdOrCtrl+Shift+KeyD";

/// The argument used by launchers that can pass process arguments.
///
/// A launch the machine started is not a launch anybody asked to look at, so it
/// stops at the tray. Windows and Linux hand the flag through as an ordinary
/// argument. macOS Login Items carry the equivalent `hidden` property instead
/// of exposing `ProgramArguments`; the AppleScript launcher selects that native
/// property while this flag remains the cross-platform fallback.
pub const STANDBY_FLAG: &str = "--hidden";

/// Modifiers that put a combination out of reach of ordinary typing.
///
/// Shift is not among them: Shift plus a letter is a capital letter, and a
/// global hotkey on one would take every capital D on the machine.
const REQUIRED: Modifiers = Modifiers::CONTROL
    .union(Modifiers::ALT)
    .union(Modifiers::SUPER);

/// Whether this process was started by the login item rather than by a person.
pub fn standby() -> bool {
    std::env::args().any(|argument| argument == STANDBY_FLAG)
}

/// The accelerator this process asked the system for, and whether it got it.
///
/// Kept as two facts because they disagree: another application already holding
/// the combination makes the registration fail without making the choice wrong,
/// and a setting that quietly unset itself because something else happened to be
/// running at login is worse than one that says it is being blocked.
#[derive(Default)]
pub struct Keys {
    wanted: Mutex<Option<String>>,
    held: AtomicBool,
    /// Serializes settings changes from multiple windows and keeps read/modify/write atomic.
    changes: Mutex<()>,
}

/// What the settings pane shows, and what every change here answers with.
///
/// Setters return the whole of it rather than an acknowledgement, so the pane
/// never has to guess what a change did — there is one description of this
/// machine's state and both sides read it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Startup {
    /// Whether the operating system has a login item for this application.
    pub autostart: bool,
    /// The accelerator the user chose, if any.
    pub shortcut: Option<String>,
    /// Whether that accelerator is registered right now. False while one is set
    /// means something else on this machine is holding the combination.
    pub held: bool,
    /// What to offer when nothing is chosen yet.
    pub suggested: &'static str,
    /// Which background outcomes are allowed to ask for attention.
    pub notifications: Notifications,
    /// Minimum severity persisted to the bounded desktop log.
    pub log_level: crate::logging::LogLevel,
    /// Fixed loopback port for plugins that persist state by Web origin. None
    /// keeps the collision-free OS-assigned default.
    pub harness_port: Option<u16>,
}

/// Notification preferences owned by the desktop shell.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Notifications {
    pub turn_completed: bool,
    pub turn_failed: bool,
    pub job_completed: bool,
    pub job_failed: bool,
}

impl Default for Notifications {
    fn default() -> Self {
        Self {
            turn_completed: true,
            turn_failed: true,
            job_completed: true,
            job_failed: true,
        }
    }
}

#[derive(Clone, Copy)]
pub enum Attention {
    TurnCompleted,
    TurnFailed,
    JobCompleted,
    JobFailed,
}

/// Restore the shortcut the user chose last time.
///
/// The login item needs nothing restored — it is the system's own record, and
/// the system is what acted on it to get here.
pub fn wire<R: Runtime>(app: &AppHandle<R>) {
    let wanted = read().shortcut;
    let keys = Keys::default();

    if let Some(accelerator) = &wanted {
        // A failure here is a conflict with another program, not a reason to
        // stop: the pane reports the combination as taken and the user picks
        // another one. Nothing else in the application depends on the key.
        keys.held
            .store(hold(app, accelerator).is_ok(), Ordering::Relaxed);
    }
    if let Ok(mut held) = keys.wanted.lock() {
        *held = wanted;
    }

    app.manage(keys);
}

#[tauri::command]
pub fn startup_state<R: Runtime>(app: AppHandle<R>, keys: State<'_, Keys>) -> Startup {
    report(&app, &keys)
}

/// Add or remove the login item, and answer with what the system now says.
#[tauri::command]
pub fn startup_autostart<R: Runtime>(
    app: AppHandle<R>,
    keys: State<'_, Keys>,
    enabled: bool,
) -> Result<Startup> {
    let manager = app.autolaunch();
    let outcome = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    outcome.map_err(|cause| Error::Startup(cause.to_string()))?;

    Ok(report(&app, &keys))
}

/// Take a global key, or give up the one being held.
///
/// `None` is the way off. Anything else is registered before it is written down,
/// so a combination the system refuses is never saved as though it worked.
#[tauri::command]
pub fn startup_shortcut<R: Runtime>(
    app: AppHandle<R>,
    keys: State<'_, Keys>,
    accelerator: Option<String>,
) -> Result<Startup> {
    let _change = keys
        .changes
        .lock()
        .map_err(|_| Error::Startup("startup settings are unavailable".into()))?;
    let previous = keys.wanted.lock().ok().and_then(|wanted| wanted.clone());

    // Released first either way: a change to the combination has to give up the
    // old one, and a failure to take the new one must not leave both live.
    release(&app);
    keys.held.store(false, Ordering::Relaxed);

    if let Some(accelerator) = &accelerator {
        if let Err(refused) = hold(&app, accelerator) {
            // The old combination was let go to make room for this one, so a
            // refusal here would otherwise cost the setting as well as the
            // change — the pane would still show a key that nothing holds.
            restore_shortcut(&app, &keys, previous.as_deref());
            return Err(refused);
        }
        keys.held.store(true, Ordering::Relaxed);
    }

    let mut saved = read();
    saved.shortcut = accelerator.clone();
    if let Err(failure) = write(&saved) {
        release(&app);
        keys.held.store(false, Ordering::Relaxed);
        restore_shortcut(&app, &keys, previous.as_deref());
        return Err(failure);
    }
    if let Ok(mut wanted) = keys.wanted.lock() {
        *wanted = accelerator;
    }

    Ok(report(&app, &keys))
}

/// Change one notification preference without overwriting choices made by
/// another window between its read and this write.
#[tauri::command]
pub fn startup_notification<R: Runtime>(
    app: AppHandle<R>,
    keys: State<'_, Keys>,
    kind: String,
    enabled: bool,
) -> Result<Startup> {
    if enabled {
        app.notification().request_permission().map_err(|cause| {
            Error::Startup(format!("notification permission was not granted: {cause}"))
        })?;
    }
    let _change = keys
        .changes
        .lock()
        .map_err(|_| Error::Startup("startup settings are unavailable".into()))?;
    let mut saved = read();
    match kind.as_str() {
        "turn-completed" => saved.notifications.turn_completed = enabled,
        "turn-failed" => saved.notifications.turn_failed = enabled,
        "job-completed" => saved.notifications.job_completed = enabled,
        "job-failed" => saved.notifications.job_failed = enabled,
        _ => {
            return Err(Error::Startup(
                "the notification preference is not supported".into(),
            ))
        }
    }
    write(&saved)?;
    Ok(report(&app, &keys))
}

/// Ask the operating system to register DSH Studio and send one explicit test
/// notification. macOS adds an application to Notification Center when its
/// first native notification is delivered; keeping this behind a button avoids
/// interrupting a first launch while giving Settings a deterministic repair
/// path for an app that was previously denied or never listed.
#[tauri::command]
pub fn startup_notification_test<R: Runtime>(
    app: AppHandle<R>,
    keys: State<'_, Keys>,
) -> Result<Startup> {
    app.notification().request_permission().map_err(|cause| {
        Error::Startup(format!("notification permission was not granted: {cause}"))
    })?;
    crate::desktop::notify(
        &app,
        crate::locale::pick("DSH Studio notifications", "DSH Studio 通知"),
        crate::locale::pick("Notifications are working.", "通知功能正常。"),
    )?;
    Ok(report(&app, &keys))
}

/// Change the persistent log threshold immediately and durably.
#[tauri::command]
pub fn startup_log_level<R: Runtime>(
    app: AppHandle<R>,
    keys: State<'_, Keys>,
    state: State<'_, crate::harness::commands::AppState>,
    level: String,
) -> Result<Startup> {
    let level = crate::logging::LogLevel::parse(&level)?;
    state.supervisor.set_log_level(level)?;
    Ok(report(&app, &keys))
}

/// Choose a stable Web origin, or return to the collision-free random default.
#[tauri::command]
pub fn startup_harness_port<R: Runtime>(
    app: AppHandle<R>,
    keys: State<'_, Keys>,
    port: Option<u16>,
) -> Result<Startup> {
    if port.is_some_and(|port| port < 1_024) {
        return Err(Error::Startup(
            "a fixed Harness port must be between 1024 and 65535".into(),
        ));
    }
    let _change = keys
        .changes
        .lock()
        .map_err(|_| Error::Startup("startup settings are unavailable".into()))?;
    let mut saved = read();
    saved.harness_port = port;
    write(&saved)?;
    Ok(report(&app, &keys))
}

/// Port passed to the next Harness process. Zero asks the OS for a free one.
pub fn harness_port() -> u16 {
    read().harness_port.unwrap_or(0)
}

/// Read at the moment attention would be requested. Notifications are rare,
/// and this makes changes from another window effective without a second cache.
pub fn attention_enabled(attention: Attention) -> bool {
    let notifications = read().notifications;
    match attention {
        Attention::TurnCompleted => notifications.turn_completed,
        Attention::TurnFailed => notifications.turn_failed,
        Attention::JobCompleted => notifications.job_completed,
        Attention::JobFailed => notifications.job_failed,
    }
}

fn report<R: Runtime>(app: &AppHandle<R>, keys: &Keys) -> Startup {
    let saved = read();
    Startup {
        // Asked of the system rather than remembered, because the login item can
        // be taken away from outside this application — Task Manager's startup
        // tab and macOS's own settings panel both do exactly that.
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        shortcut: keys.wanted.lock().ok().and_then(|wanted| wanted.clone()),
        held: keys.held.load(Ordering::Relaxed),
        suggested: SUGGESTED,
        notifications: saved.notifications,
        log_level: crate::logging::configured_level(),
        harness_port: saved.harness_port,
    }
}

/// Read a combination, and refuse one that would be rude to take.
///
/// The vocabulary is `KeyboardEvent.code` — `KeyD`, `Digit1`, `ArrowUp` — which
/// is what the recorder in the settings pane reports and what the hotkey parser
/// happens to read. That coincidence is what lets a keypress become a stored
/// accelerator without a translation table in between.
fn parse(accelerator: &str) -> Result<Shortcut> {
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|_| Error::Startup(format!("{accelerator} is not a key combination")))?;

    if !shortcut.mods.intersects(REQUIRED) {
        return Err(Error::Startup(
            "a global shortcut needs Ctrl, Alt or the platform key, or it would take that key away from every other application".into(),
        ));
    }

    Ok(shortcut)
}

/// Ask the system for a combination and point it at the window.
fn hold<R: Runtime>(app: &AppHandle<R>, accelerator: &str) -> Result<()> {
    let shortcut = parse(accelerator)?;

    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            // Both halves of the press arrive. Acting on each would summon the
            // window and put it away again in one keystroke.
            if event.state() == ShortcutState::Pressed {
                summon(app);
            }
        })
        .map_err(|cause| Error::Startup(cause.to_string()))
}

fn release<R: Runtime>(app: &AppHandle<R>) {
    // Everything, because this application only ever holds the one — and a
    // targeted unregister would need the old accelerator to still parse, which
    // is not true of a file somebody edited by hand.
    let _ = app.global_shortcut().unregister_all();
}

fn restore_shortcut<R: Runtime>(app: &AppHandle<R>, keys: &Keys, accelerator: Option<&str>) {
    let held = accelerator.is_some_and(|accelerator| hold(app, accelerator).is_ok());
    keys.held.store(held, Ordering::Relaxed);
}

/// Bring the window forward, or put it away if it is already what is in front.
///
/// Toggling rather than only summoning, because the key is pressed from inside
/// another application: whoever wants a look at the harness wants the same
/// keystroke to give the screen back.
fn summon<R: Runtime>(app: &AppHandle<R>) {
    let Some(main) = window::front(app) else {
        return;
    };

    let showing = main.is_visible().unwrap_or(false)
        && !main.is_minimized().unwrap_or(false)
        && main.is_focused().unwrap_or(false);

    if showing {
        let _ = main.hide();
    } else {
        window::reveal(&main);
    }
}

/// What is written down between runs.
///
/// The login item is not in here: it is the operating system's own record, and
/// keeping a second copy would only create something to disagree with.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Saved {
    shortcut: Option<String>,
    notifications: Notifications,
    harness_port: Option<u16>,
}

fn file() -> PathBuf {
    paths::app_data_dir().join("startup.json")
}

/// No file before the first change, and a corrupt one is no worse than none.
fn read() -> Saved {
    std::fs::read(file())
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

/// Unlike the window's remembered placement, this one reports what went wrong.
/// A convenience that fails silently costs a centred window; a setting that
/// fails silently is a switch that flips back the next time the app starts.
fn write(saved: &Saved) -> Result<()> {
    let path = file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|cause| Error::Startup(cause.to_string()))?;
    }
    let raw = serde_json::to_vec(saved).map_err(|cause| Error::Startup(cause.to_string()))?;
    crate::atomic::write(&path, raw).map_err(|cause| Error::Startup(cause.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The combination the pane fills in has to be one the parser accepts on
    /// whichever platform this is compiled for — `CmdOrCtrl` is the token that
    /// makes that true, and a typo in it would only show up at runtime.
    #[test]
    fn the_suggested_combination_parses() {
        let shortcut = parse(SUGGESTED).expect("the suggestion must be usable");
        assert!(shortcut.mods.contains(Modifiers::SHIFT));
    }

    /// The recorder sends `KeyboardEvent.code`, which is the same vocabulary the
    /// parser reads. If that ever stopped being true every recorded shortcut
    /// would fail at the moment it was chosen.
    #[test]
    fn the_codes_a_browser_reports_are_the_codes_the_parser_takes() {
        for accelerator in [
            "Control+Shift+KeyD",
            "Alt+Digit1",
            "Super+Space",
            "Control+Alt+ArrowUp",
            "Control+F12",
            "Control+Shift+Backquote",
            "Alt+NumpadAdd",
        ] {
            assert!(parse(accelerator).is_ok(), "{accelerator}");
        }
    }

    /// Shift is a typing modifier, not a reaching-past-everything one. Letting
    /// it through would hand this application every capital D on the machine.
    #[test]
    fn shift_alone_is_not_enough_to_claim_a_key() {
        assert!(parse("Shift+KeyD").is_err());
        assert!(parse("KeyD").is_err());
        assert!(parse("F5").is_err());

        assert!(parse("Control+KeyD").is_ok());
        assert!(parse("Alt+KeyD").is_ok());
        assert!(parse("Super+KeyD").is_ok());
    }

    /// Nonsense from a hand-edited file must be refused rather than registered
    /// as something else.
    #[test]
    fn a_combination_that_is_not_one_is_refused() {
        for accelerator in ["", "Control+", "Control+Shift", "Ctrl+Nope", "+"] {
            assert!(parse(accelerator).is_err(), "{accelerator}");
        }
    }

    /// The flag is the whole protocol between the login item and this process,
    /// and it is written down in two places — here and in the plugin's argument
    /// list in `lib.rs`.
    #[test]
    fn the_standby_flag_is_a_flag() {
        assert!(STANDBY_FLAG.starts_with("--"));
    }

    #[test]
    fn notifications_default_on_and_old_files_migrate() {
        let saved: Saved = serde_json::from_str(r#"{"shortcut":"Control+KeyD"}"#).unwrap();
        assert_eq!(saved.notifications, Notifications::default());
        assert!(saved.notifications.turn_completed);
        assert!(saved.notifications.turn_failed);
        assert!(saved.notifications.job_completed);
        assert!(saved.notifications.job_failed);
        assert_eq!(saved.harness_port, None);
    }

    #[test]
    fn old_settings_without_a_port_keep_the_random_default() {
        let saved: Saved =
            serde_json::from_str(r#"{"notifications":{"turnCompleted":false}}"#).unwrap();
        assert_eq!(saved.harness_port, None);
    }
}

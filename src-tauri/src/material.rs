//! The material the window is drawn on.
//!
//! A backdrop is the one piece of chrome an application cannot fake. It samples
//! what is *behind* the window, so the window stops reading as a rectangle
//! pasted onto the desktop and starts reading as part of it. Every platform
//! spells it differently, and Windows spells it differently again per build,
//! which is why the choice is made here rather than declared in
//! `tauri.conf.json`.
//!
//! Two facts make that choice load-bearing rather than cosmetic:
//!
//! * Tauri applies the first effect it recognises in the list and discards the
//!   error, so a list of effects is not a fallback chain. The version test has
//!   to happen in Rust, before the window exists.
//! * A transparent window with nothing drawn behind it is a hole onto the
//!   desktop. Transparency is therefore requested only when this machine will
//!   actually put something there, which is the same decision — so it is made
//!   once, here, and everything else reads the answer.

use serde::Serialize;
use tauri::utils::config::WindowEffectsConfig;
use tauri::window::{Color, Effect, EffectState};
use tauri::{Runtime, WebviewWindow};

/// The backdrop this machine can draw, if any.
///
/// Named for what the platform calls it rather than for the API that applies it:
/// this is the value the frontend switches its grounds on, and "mica-alt" is a
/// thing a reader can go and look at a picture of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
// Every variant is constructed, but never all of them on one target — the
// compiler cannot see the other three builds, and this type is the vocabulary
// they share. Splitting it per platform would only move the same fact into
// `#[cfg]` on half the arms of `config` below.
#[allow(dead_code)]
pub enum Material {
    /// Windows 11 22H2 and later. Tauri spells it `Tabbed` and the compositor
    /// spells it `DWMSBT_TABBEDWINDOW`, but the design language it belongs to
    /// calls it Mica Alt — the deeper of the two Mica tints, meant for exactly
    /// this shape of window, where the top strip is chrome and not content.
    /// There is no `MicaAlt` spelling to ask for instead.
    MicaAlt,
    /// Windows 11 before 22H2, where Mica exists but only through the
    /// undocumented attribute, and the tabbed variant does not exist at all.
    Mica,
    /// Windows 10 1809 and later. A live blur of whatever is behind the window
    /// rather than a wallpaper tint, and the only one of these that needs to be
    /// told what colour to be.
    Acrylic,
    /// macOS, where the sidebar material is what a source-list window uses — and
    /// the reason a Mac window's chrome shifts as it is dragged over something
    /// else.
    Vibrancy,
}

/// What this machine can draw, decided before the window is built.
#[cfg(target_os = "windows")]
pub fn supported() -> Option<Material> {
    /// Windows 11 22H2: the first build with a documented backdrop attribute,
    /// and the first with a tabbed variant to ask for.
    const MICA_ALT: u32 = 22523;
    /// Windows 11: Mica through the undocumented attribute.
    const MICA: u32 = 22000;
    /// Windows 10 1809: the oldest build that can blur behind a window.
    const ACRYLIC: u32 = 17763;

    match windows_version::OsVersion::current().build {
        build if build >= MICA_ALT => Some(Material::MicaAlt),
        build if build >= MICA => Some(Material::Mica),
        build if build >= ACRYLIC => Some(Material::Acrylic),
        _ => None,
    }
}

/// Every macOS this app supports has `NSVisualEffectView`.
#[cfg(target_os = "macos")]
pub fn supported() -> Option<Material> {
    Some(Material::Vibrancy)
}

/// Nothing on Linux, on purpose.
///
/// Blur there is the compositor's decision and not the window's: the same code
/// gets a frosted panel under KWin, an unblurred hole under a compositor with
/// the effect switched off, and nothing at all under one that does not composite.
/// An opaque window is the only version of this that looks deliberate everywhere.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn supported() -> Option<Material> {
    None
}

/// Put the material behind the window, in the given light or dark.
///
/// `dark` is not decoration. On Windows the Mica attributes carry the frame's
/// immersive-dark-mode flag with them, which is what colours the resize border
/// and the snap layouts flyout — so the theme switch in the title bar has to
/// reach the compositor, not just the stylesheet.
pub fn apply<R: Runtime>(window: &WebviewWindow<R>, material: Material, dark: bool) {
    // Best effort throughout: a window with no backdrop is a window that looks
    // plainer than intended, which is not worth failing a launch over.
    let _ = window.set_effects(config(material, dark));
}

fn config(material: Material, dark: bool) -> WindowEffectsConfig {
    let effect = match (material, dark) {
        (Material::MicaAlt, true) => Effect::TabbedDark,
        (Material::MicaAlt, false) => Effect::TabbedLight,
        (Material::Mica, true) => Effect::MicaDark,
        (Material::Mica, false) => Effect::MicaLight,
        (Material::Acrylic, _) => Effect::Acrylic,
        (Material::Vibrancy, _) => Effect::Sidebar,
    };

    WindowEffectsConfig {
        effects: vec![effect],
        // macOS only, and the reason a Mac window's material goes quiet when the
        // window is not the one being used.
        state: matches!(material, Material::Vibrancy)
            .then_some(EffectState::FollowsWindowActiveState),
        color: matches!(material, Material::Acrylic).then(|| tint(dark)),
        ..Default::default()
    }
}

/// What Windows 10's acrylic is tinted with.
///
/// Acrylic blurs the desktop instead of sampling a wallpaper tint, and given no
/// colour it borrows the system accent — a shade this palette never chose, and
/// one that can land anywhere. These are `--color-surface` from `app.css` in
/// each theme, at the opacity that still keeps an 11px status line legible with
/// something bright behind the window.
fn tint(dark: bool) -> Color {
    if dark {
        Color(0x12, 0x16, 0x1f, 0xbe)
    } else {
        Color(0xff, 0xff, 0xff, 0xbe)
    }
}

/// Follow the theme the frontend resolved.
///
/// Sync rather than async on purpose: `set_effects` hops to the main thread by
/// itself, and a sync command is the one shape tauri does not put on the async
/// runtime first — so the compositor changes in the same turn the stylesheet
/// does, instead of a frame or two behind it.
#[tauri::command]
pub fn window_material<R: Runtime>(window: WebviewWindow<R>, dark: bool) {
    if let Some(material) = supported() {
        apply(&window, material, dark);
    }
}

//! Which language the native chrome speaks.
//!
//! The web layer picks its own language from `navigator.language`, but menus
//! and tray entries are built by the operating system and never see that — so
//! the same question has to be answered once more, here.
//!
//! Kept to the one distinction the app actually makes. See `src/lib/i18n.ts`;
//! the two must agree, and this is the only place the Rust half decides.

use std::sync::OnceLock;

/// Whether native chrome should be in Chinese.
///
/// Read once: the OS language does not change under a running process, and a
/// tray menu built at startup could not follow it if it did.
pub fn prefers_chinese() -> bool {
    static CHOICE: OnceLock<bool> = OnceLock::new();
    *CHOICE.get_or_init(|| {
        sys_locale::get_locale()
            .map(|tag| tag.to_ascii_lowercase().starts_with("zh"))
            .unwrap_or(false)
    })
}

/// Pick between two fixed strings by language.
///
/// A dictionary would be the right shape for a hundred strings. For the handful
/// the native chrome needs, it would only put the two halves of each sentence in
/// different files.
pub fn pick(english: &'static str, chinese: &'static str) -> &'static str {
    if prefers_chinese() {
        chinese
    } else {
        english
    }
}

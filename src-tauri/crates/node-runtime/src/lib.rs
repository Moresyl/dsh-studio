//! Locate a Node.js runtime the application can use.
//!
//! The DeepSeek Harness CLI is a Node program, so a native shell around it still
//! has to answer one question before it can do anything: which `node` on this
//! machine should run it? This crate answers that by enumerating the version
//! managers people actually use and interrogating each install, rather than
//! trusting `PATH` alone.

mod detect;
mod version;

pub use detect::{
    discover, discover_in, plain_path, probe, release_executable, NodeInstallation, Source,
};
pub use version::Version;

/// Lowest Node release this application will run the harness on.
///
/// The verified Harness family is composed and tested on Node 22.19 or newer,
/// and its pinned pnpm runtime requires Node 22.13. Keeping the higher upstream
/// floor prevents an install that succeeds only to fail during profile boot.
pub const MINIMUM_SUPPORTED: Version = Version::new(22, 19, 0);

/// The best runtime to use, or `None` when nothing on this machine qualifies.
pub fn best_available() -> Option<NodeInstallation> {
    discover()
        .into_iter()
        .find(|install| install.version >= MINIMUM_SUPPORTED)
}

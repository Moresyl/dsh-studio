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
/// The `@deepseek-ai/dsh` package publishes no `engines` field, so this is a
/// deliberate floor rather than a value read from upstream: Node 20 is the
/// oldest release line still receiving security support, and everything below it
/// predates the stable `node:` built-ins the harness dependency tree relies on.
pub const MINIMUM_SUPPORTED: Version = Version::new(20, 0, 0);

/// The best runtime to use, or `None` when nothing on this machine qualifies.
pub fn best_available() -> Option<NodeInstallation> {
    discover()
        .into_iter()
        .find(|install| install.version >= MINIMUM_SUPPORTED)
}

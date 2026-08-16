//! Failures the UI has to explain to a person.
//!
//! Every variant is written as a sentence a user can act on, because these
//! strings are what the startup screen shows when something goes wrong.

use std::io;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not set up process reclamation: {0}")]
    ProcessGuard(#[source] io::Error),

    #[error("could not start the harness process: {0}")]
    Spawn(#[source] io::Error),

    #[error("{0}")]
    Readiness(String),

    #[error("the harness is already starting")]
    AlreadyStarting,

    #[error("no Node.js {minimum} or newer was found on this machine")]
    NoNodeRuntime { minimum: node_runtime::Version },

    #[error("the harness is not installed yet")]
    HarnessNotInstalled,

    #[error("this Node.js install has no npm next to it, so the harness cannot be installed")]
    NpmMissing,

    #[error("the harness could not be installed: {0}")]
    Install(String),

    #[error("an install is already running")]
    AlreadyInstalling,

    #[error("{0}")]
    Network(String),

    #[error("start the harness before opening it to your other devices")]
    RemoteNeedsHarness,

    #[error("this machine is not on a network any other device could reach it over")]
    RemoteNoNetwork,

    #[error("could not open a port for remote access: {0}")]
    RemoteBind(#[source] io::Error),

    #[error("the system entropy source is unavailable, so no pairing secret can be made")]
    NoEntropy,

    #[error("{0}")]
    Plugin(String),

    #[error("a plugin change is already running")]
    PluginBusy,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Tauri commands hand errors to the frontend as JSON, so they must serialize.
/// The message is the whole contract; the variant shape is an internal detail.
impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

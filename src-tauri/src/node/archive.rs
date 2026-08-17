//! Unpack an official Node archive.
//!
//! Two formats, because Node ships two: a zip on Windows and a gzipped tar
//! everywhere else. Both wrap the whole release in one directory named after it,
//! so neither branch strips anything — the archive is expanded into a staging
//! directory as-is and the caller is handed the release directory that appeared
//! inside. That leaves the last step of an install as a rename of a complete
//! tree, which is as close to atomic as this gets, and it keeps the extraction
//! itself on the path each crate tests: `..` entries, symlinks, hard links and
//! file modes are all handled by code whose job that is, not by a loop here.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Expand `archive` into `staging` and return the release directory inside it.
pub fn unpack(archive: &Path, staging: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(staging).map_err(|cause| {
        Error::NodeProvision(format!("nowhere to unpack the download: {cause}"))
    })?;
    expand(archive, staging)?;
    sole_directory(staging)
}

#[cfg(windows)]
fn expand(archive: &Path, staging: &Path) -> Result<()> {
    let file = std::fs::File::open(archive).map_err(unreadable)?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|cause| {
        Error::NodeProvision(format!("the download is not a readable zip: {cause}"))
    })?;

    zip.extract(staging).map_err(|cause| {
        Error::NodeProvision(format!("the download could not be unpacked: {cause}"))
    })
}

#[cfg(not(windows))]
fn expand(archive: &Path, staging: &Path) -> Result<()> {
    let file = std::fs::File::open(archive).map_err(unreadable)?;
    let decoded = flate2::read::GzDecoder::new(std::io::BufReader::new(file));

    // Node's tarballs contain symlinks — `bin/npm` points into
    // `lib/node_modules` — and the runtime is unusable without them, so this
    // must be `tar`'s own unpacker rather than a copy loop.
    tar::Archive::new(decoded).unpack(staging).map_err(|cause| {
        Error::NodeProvision(format!("the download could not be unpacked: {cause}"))
    })
}

fn unreadable(cause: std::io::Error) -> Error {
    Error::NodeProvision(format!("the download could not be read back: {cause}"))
}

/// The one directory inside `staging`, or a refusal.
///
/// An archive that expanded to nothing, or to a shape with no single root, is
/// not the release this code knows how to install — and guessing which of two
/// directories was meant would install half a runtime that fails later, further
/// from the cause.
fn sole_directory(staging: &Path) -> Result<PathBuf> {
    let mut directories = std::fs::read_dir(staging)
        .map_err(|cause| {
            Error::NodeProvision(format!("the unpacked download could not be read: {cause}"))
        })?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir());

    match (directories.next(), directories.next()) {
        (Some(release), None) => Ok(release),
        _ => Err(Error::NodeProvision(
            "the download did not unpack to a single Node release directory".into(),
        )),
    }
}

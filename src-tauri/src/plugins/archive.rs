//! Plugins that arrive as a file instead of from a registry.
//!
//! A machine on an isolated network has no registry to search, and the people
//! running one are the people most likely to have been handed a plugin as a
//! file. Nothing here invents a format for that: an npm tarball is already the
//! unit a registry serves, `npm pack` is already how one is made, and pnpm
//! already installs from a path. What this module adds is the two things doing
//! it by hand would not — reading the manifest out of the file so the user is
//! told what they are about to install, and keeping a copy of the file, because
//! the profile manifest ends up pointing at it.
//!
//! The one platform detail worth knowing before reading further is in [`spec`].

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::paths;

/// npm puts every file in a package under this directory, whatever it is called.
const MANIFEST: &str = "package/package.json";

/// How much of the archive may be decompressed while looking for the manifest.
///
/// Not a limit on plugins — the manifest is at the front of anything `npm pack`
/// writes, so a package of any size is read in the first few kilobytes. It is a
/// limit on what a file that is *not* one can cost: gzip will happily expand a
/// few hundred bytes into as much as anything is willing to read.
const READ_CEILING: u64 = 64 << 20;

/// A manifest is small. One that is not is not one to hand to a JSON parser.
const MANIFEST_CEILING: u64 = 1 << 20;

/// What is in the file, read before anything is installed from it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub name: String,
    pub version: String,
    pub description: String,
    /// Whether it declares a profile patch — the same question the marketplace
    /// asks of a published manifest, and the difference between a plugin and a
    /// package that merely mentions the harness.
    pub bundle: bool,
    /// The file it was read from, so a confirmation can name it.
    pub path: String,
    pub bytes: u64,
}

/// A staged archive: where the copy went, and whether staging is what put it
/// there. An install that fails may only delete a file it introduced — the same
/// package may already have been imported, and another profile may be
/// installing from it.
pub(super) struct Staged {
    pub path: PathBuf,
    pub fresh: bool,
}

/// Read a plugin archive without installing anything from it.
///
/// Everything the panel shows about a package comes from here, so a file that
/// is not a package has to be turned away with a sentence rather than left to
/// fail later as a package manager error nobody can act on.
pub fn read(path: &Path) -> Result<Package> {
    let file = std::fs::File::open(path)
        .map_err(|cause| Error::Plugin(format!("{} could not be opened: {cause}", show(path))))?;
    let bytes = file.metadata().map(|meta| meta.len()).unwrap_or_default();

    let decoded = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut archive = tar::Archive::new(decoded.take(READ_CEILING));
    let entries = archive.entries().map_err(|cause| unreadable(path, cause))?;

    for entry in entries {
        let entry = entry.map_err(|cause| unreadable(path, cause))?;
        // A tar path can be anything at all, including nothing this platform can
        // spell. One that cannot be read is one that is not the manifest.
        let Ok(inside) = entry.path() else { continue };
        if inside != Path::new(MANIFEST) {
            continue;
        }

        let mut raw = String::new();
        entry
            .take(MANIFEST_CEILING)
            .read_to_string(&mut raw)
            .map_err(|cause| unreadable(path, cause))?;

        return describe(path, &raw, bytes);
    }

    Err(Error::Plugin(format!(
        "{} has no package.json in it, so it is not a package this can install",
        show(path)
    )))
}

/// Put a copy of the archive somewhere it will still be tomorrow.
///
/// pnpm records a tarball install as the path it was installed from, so the
/// file the user picked becomes part of the profile: reinstalling that profile,
/// or duplicating it, reads the same path again. A file in Downloads is not a
/// promise anybody made, so the app keeps its own.
pub(super) fn stage(source: &Path, package: &Package) -> Result<Staged> {
    let directory = paths::imports_dir();
    std::fs::create_dir_all(&directory).map_err(|cause| {
        Error::Plugin(format!(
            "{} could not be made to keep imported plugins in: {cause}",
            show(&directory)
        ))
    })?;

    let path = directory.join(file_name(&package.name, &package.version));
    // Importing the kept copy again, which is what picking it out of this
    // directory comes to. Copying a file onto itself empties it.
    if same_file(source, &path) {
        return Ok(Staged { path, fresh: false });
    }

    let fresh = !path.exists();
    // Overwritten on purpose when it is not fresh: the same name and version
    // being imported again is somebody who rebuilt it, and the new one is the
    // one they mean.
    std::fs::copy(source, &path).map_err(|cause| {
        Error::Plugin(format!(
            "{} could not be copied to {}: {cause}",
            show(source),
            show(&directory)
        ))
    })?;
    Ok(Staged { path, fresh })
}

/// The argument the package manager has to be handed to install this file.
///
/// Quoted on Windows and bare everywhere else, and that is not a matter of
/// taste. `dsh plugin` forwards its arguments to pnpm through a shell on
/// Windows and through a plain spawn on every other platform, so the same
/// string cannot serve both: unquoted, a shell splits `C:\Program Files\x.tgz`
/// into two arguments; quoted, a plain spawn takes the quotes for part of the
/// file name and looks for a file that does not exist.
pub(super) fn spec(path: &Path) -> String {
    let shown = path.display().to_string();
    if cfg!(windows) {
        format!("\"{shown}\"")
    } else {
        shown
    }
}

/// Turn a package manifest into what the panel shows about it.
fn describe(path: &Path, raw: &str, bytes: u64) -> Result<Package> {
    let manifest: serde_json::Value = serde_json::from_str(raw).map_err(|cause| {
        Error::Plugin(format!(
            "the package.json in {} could not be read: {cause}",
            show(path)
        ))
    })?;

    let name = manifest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    // The name is what the profile will record and what every other command in
    // this panel takes, so a file naming itself something pnpm would refuse is
    // turned away here rather than halfway through an install.
    if !super::is_package_name(&name) {
        return Err(Error::Plugin(format!(
            "{} declares no usable package name, so it is not a package this can install",
            show(path)
        )));
    }

    Ok(Package {
        name,
        version: string(&manifest, "version"),
        description: string(&manifest, "description"),
        bundle: manifest.pointer("/dsh/bundle/patch").is_some(),
        path: path.display().to_string(),
        bytes,
    })
}

/// What the copy is called: the name `npm pack` would have given it.
fn file_name(name: &str, version: &str) -> String {
    let flat = name.trim_start_matches('@').replace('/', "-");
    if version.is_empty() {
        format!("{flat}.tgz")
    } else {
        format!("{flat}-{version}.tgz")
    }
}

/// Whether two paths are the same file, answering no when either cannot be read.
///
/// Compared after resolving, because the two sides arrive by different routes —
/// one from a file dialog, one built here — and `..`, a symlink or a drive
/// mapping is enough to make one file look like two.
fn same_file(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn string(manifest: &serde_json::Value, key: &str) -> String {
    manifest
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn unreadable(path: &Path, cause: impl std::fmt::Display) -> Error {
    Error::Plugin(format!(
        "{} is not a readable .tgz package: {cause}",
        show(path)
    ))
}

/// A path as a person would recognise it, without the extended-length prefix
/// Windows hands back from `canonicalize`.
fn show(path: &Path) -> String {
    let shown = path.display().to_string();
    shown
        .strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A gzipped tar with one `package/package.json` in it, which is the only
    /// part of an npm tarball anything here reads.
    fn packed(manifest: &str) -> Vec<u8> {
        let mut tarball = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(manifest.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tarball
            .append_data(&mut header, MANIFEST, manifest.as_bytes())
            .expect("appending to a vector");

        let raw = tarball.into_inner().expect("finishing into a vector");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, &raw).expect("writing to a vector");
        encoder.finish().expect("finishing into a vector")
    }

    fn written(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("dsh-studio-archive-{name}"));
        std::fs::write(&path, bytes).expect("a writable temp directory");
        path
    }

    #[test]
    fn reads_what_a_plugin_says_about_itself() {
        let path = written(
            "plugin.tgz",
            &packed(
                r#"{
                    "name": "@vendor/dsh-notes",
                    "version": "1.4.0",
                    "description": "notes as a profile layer",
                    "dsh": { "bundle": { "patch": "./patch.js" } }
                }"#,
            ),
        );

        let package = read(&path).expect("a well-formed package");

        assert_eq!(package.name, "@vendor/dsh-notes");
        assert_eq!(package.version, "1.4.0");
        assert!(package.bundle, "it declares a patch, so it is a plugin");
        assert!(package.bytes > 0, "the file has a size worth showing");
    }

    #[test]
    fn a_package_that_patches_nothing_is_read_and_marked() {
        // Not refused: a plugin's own dependency is a legitimate thing to import
        // onto a machine with no registry. It is the panel's job to say so.
        let path = written(
            "library.tgz",
            &packed(r#"{ "name": "dsh-helper", "version": "0.1.0" }"#),
        );

        let package = read(&path).expect("a well-formed package");

        assert!(!package.bundle);
        assert_eq!(package.description, "");
    }

    #[test]
    fn refuses_a_file_that_is_not_an_archive_at_all() {
        let path = written("notes.txt", b"this is not a tarball");

        let failure = read(&path).expect_err("a text file is not a package");

        assert!(
            failure.to_string().contains("not a readable .tgz package"),
            "the sentence has to say what was wrong with the file: {failure}"
        );
    }

    #[test]
    fn refuses_an_archive_with_no_manifest_in_it() {
        let mut tarball = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(3);
        header.set_mode(0o644);
        header.set_cksum();
        tarball
            .append_data(&mut header, "package/index.js", &b"{}\n"[..])
            .expect("appending to a vector");
        let raw = tarball.into_inner().expect("finishing into a vector");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut encoder, &raw).expect("writing to a vector");
        let path = written("manifestless.tgz", &encoder.finish().expect("finishing"));

        let failure = read(&path).expect_err("no manifest, no package");

        assert!(failure.to_string().contains("no package.json"), "{failure}");
    }

    #[test]
    fn refuses_a_manifest_whose_name_is_not_a_package_name() {
        let path = written(
            "unnamed.tgz",
            &packed(r#"{ "version": "1.0.0", "description": "nameless" }"#),
        );

        let failure = read(&path).expect_err("a package needs a name");

        assert!(
            failure.to_string().contains("no usable package name"),
            "{failure}"
        );
    }

    #[test]
    fn keeps_a_copy_under_the_name_npm_would_have_packed_it_as() {
        assert_eq!(file_name("dsh-notes", "1.0.0"), "dsh-notes-1.0.0.tgz");
        assert_eq!(
            file_name("@vendor/dsh-notes", "2.1.0-beta.1"),
            "vendor-dsh-notes-2.1.0-beta.1.tgz"
        );
        // A manifest with no version is still installable, and the copy still
        // needs a name that does not collide with another package's.
        assert_eq!(file_name("dsh-notes", ""), "dsh-notes.tgz");
    }

    #[test]
    #[cfg(windows)]
    fn quotes_the_path_the_shell_would_otherwise_split() {
        let path = PathBuf::from(r"C:\Program Files\plugins\dsh-notes-1.0.0.tgz");

        assert_eq!(
            spec(&path),
            r#""C:\Program Files\plugins\dsh-notes-1.0.0.tgz""#
        );
    }

    #[test]
    #[cfg(not(windows))]
    fn leaves_the_path_alone_where_no_shell_is_involved() {
        let path = PathBuf::from("/home/someone/my plugins/dsh-notes-1.0.0.tgz");

        assert_eq!(spec(&path), "/home/someone/my plugins/dsh-notes-1.0.0.tgz");
    }

    #[test]
    fn a_file_is_the_same_file_as_itself() {
        let path = written(
            "same.tgz",
            &packed(r#"{ "name": "dsh-x", "version": "1" }"#),
        );

        assert!(same_file(&path, &path));
        assert!(
            !same_file(&path, &path.with_extension("missing")),
            "a path that is not there is not the same file as one that is"
        );
    }
}

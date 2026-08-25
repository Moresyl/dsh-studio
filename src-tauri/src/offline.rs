//! A verified runtime carried by the Full installer.
//!
//! Lite builds have no `offline/manifest.json` resource and keep using the
//! existing download paths. Full builds carry the official Node archive and a
//! platform-built Harness dependency closure. The manifest is deliberately
//! small and strict: a damaged Full package fails as a damaged package instead
//! of quietly turning an offline operation into a network request.

use std::fs::File;
use std::io::{BufReader, Read, Seek as _, SeekFrom};
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{Error, Result};

const SCHEMA: u8 = 1;
const MANIFEST: &str = "offline/manifest.json";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub file: PathBuf,
    pub sha256: String,
    pub version: String,
}

#[derive(Clone, Debug)]
pub struct Payload {
    pub node: Artifact,
    pub harness: Artifact,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: u8,
    os: String,
    arch: String,
    node: DeclaredArtifact,
    harness: DeclaredHarness,
    pnpm: DeclaredPnpm,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeclaredArtifact {
    file: String,
    sha256: String,
    version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeclaredHarness {
    file: String,
    sha256: String,
    package: String,
    version: String,
}

#[derive(Debug, Deserialize)]
struct DeclaredPnpm {
    version: String,
}

/// Read the Full payload, or report that this is a Lite build.
pub fn payload<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Payload>> {
    let manifest = app
        .path()
        .resolve(MANIFEST, BaseDirectory::Resource)
        .map_err(|cause| Error::Install(format!("offline runtime path is unavailable: {cause}")))?;
    if !manifest.is_file() {
        return Ok(None);
    }
    let Some(root) = manifest.parent() else {
        return Err(Error::Install(
            "offline runtime manifest has no resource directory".into(),
        ));
    };
    read(root).map(Some)
}

/// The immutable edition compiled into this binary.
pub fn edition() -> &'static str {
    match option_env!("DSH_STUDIO_EDITION") {
        Some("full") => "full",
        _ => "lite",
    }
}

fn read(root: &Path) -> Result<Payload> {
    let raw = crate::bounded_file::read(
        &root.join("manifest.json"),
        crate::bounded_file::CONTROL_BYTES,
    )
    .map_err(|cause| Error::Install(format!("offline runtime manifest cannot be read: {cause}")))?;
    let manifest: Manifest = serde_json::from_slice(&raw)
        .map_err(|cause| Error::Install(format!("offline runtime manifest is invalid: {cause}")))?;

    if manifest.schema != SCHEMA {
        return Err(Error::Install(format!(
            "offline runtime schema {} is not supported",
            manifest.schema
        )));
    }
    if manifest.os != std::env::consts::OS || manifest.arch != std::env::consts::ARCH {
        return Err(Error::Install(format!(
            "offline runtime is for {}-{}, not {}-{}",
            manifest.os,
            manifest.arch,
            std::env::consts::OS,
            std::env::consts::ARCH
        )));
    }
    if manifest.harness.package != crate::harness::install::PACKAGE
        || manifest.harness.version != crate::harness::install::VERSION
        || manifest.pnpm.version != crate::harness::install::PNPM_VERSION
    {
        return Err(Error::Install(
            "offline Harness/pnpm runtime does not match this DSH Studio build".into(),
        ));
    }
    if node_runtime::Version::parse(&manifest.node.version).is_none() {
        return Err(Error::Install(
            "offline Node runtime has an invalid version".into(),
        ));
    }

    Ok(Payload {
        node: artifact(
            root,
            manifest.node.file,
            manifest.node.sha256,
            manifest.node.version,
        )?,
        harness: artifact(
            root,
            manifest.harness.file,
            manifest.harness.sha256,
            manifest.harness.version,
        )?,
    })
}

fn artifact(root: &Path, file: String, sha256: String, version: String) -> Result<Artifact> {
    let path = Path::new(&file);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(Error::Install(
            "offline runtime manifest contains an unsafe file name".into(),
        ));
    }
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error::Install(
            "offline runtime manifest contains an invalid SHA-256".into(),
        ));
    }
    let file = root.join(path);
    if !file.is_file() {
        return Err(Error::Install(format!(
            "offline runtime is missing {}",
            file.display()
        )));
    }
    Ok(Artifact {
        file,
        sha256: sha256.to_ascii_lowercase(),
        version,
    })
}

/// Open, authenticate and rewind one immutable packaged artifact.
///
/// The returned handle is the one that was hashed. Callers extract from this
/// handle so replacing the path between verification and extraction cannot
/// substitute different bytes.
pub(crate) fn verified_file(artifact: &Artifact) -> Result<File> {
    let file = File::open(&artifact.file)
        .map_err(|cause| Error::Install(format!("offline runtime could not be opened: {cause}")))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|cause| {
            Error::Install(format!("offline runtime could not be verified: {cause}"))
        })?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let actual = format!("{:x}", digest.finalize());
    if actual != artifact.sha256 {
        return Err(Error::Install(format!(
            "offline runtime {} failed its SHA-256 check",
            artifact.file.display()
        )));
    }
    reader.seek(SeekFrom::Start(0)).map_err(|cause| {
        Error::Install(format!("offline runtime could not be rewound: {cause}"))
    })?;
    Ok(reader.into_inner())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Read as _;

    use sha2::{Digest as _, Sha256};

    use super::{read, verified_file, Artifact};

    fn root(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "dsh-studio-offline-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn manifest(node_file: &str, harness_version: &str) -> String {
        format!(
            r#"{{"schema":1,"os":"{}","arch":"{}","node":{{"file":"{node_file}","sha256":"{}","version":"v22.19.0"}},"harness":{{"file":"harness.tar.gz","sha256":"{}","package":"{}","version":"{harness_version}"}},"pnpm":{{"version":"{}"}}}}"#,
            std::env::consts::OS,
            std::env::consts::ARCH,
            "0".repeat(64),
            "1".repeat(64),
            crate::harness::install::PACKAGE,
            crate::harness::install::PNPM_VERSION,
        )
    }

    #[test]
    fn accepts_only_the_current_platform_and_runtime_contract() {
        let root = root("valid");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("node.tar.gz"), b"node").unwrap();
        fs::write(root.join("harness.tar.gz"), b"harness").unwrap();
        fs::write(
            root.join("manifest.json"),
            manifest("node.tar.gz", crate::harness::install::VERSION),
        )
        .unwrap();
        let payload = read(&root).expect("valid manifest");
        assert_eq!(payload.harness.version, crate::harness::install::VERSION);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_paths_and_a_mismatched_harness() {
        let root = root("refuse");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("harness.tar.gz"), b"harness").unwrap();
        fs::write(
            root.join("manifest.json"),
            manifest("../node.tar.gz", crate::harness::install::VERSION),
        )
        .unwrap();
        assert!(read(&root).is_err());

        fs::write(root.join("node.tar.gz"), b"node").unwrap();
        fs::write(root.join("manifest.json"), manifest("node.tar.gz", "0.0.0")).unwrap();
        assert!(read(&root).is_err());

        let wrong_pnpm = manifest("node.tar.gz", crate::harness::install::VERSION)
            .replace(crate::harness::install::PNPM_VERSION, "0.0.0");
        fs::write(root.join("manifest.json"), wrong_pnpm).unwrap();
        assert!(read(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn extraction_keeps_the_same_handle_that_passed_verification() {
        let root = root("verified-handle");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("runtime.tar.gz");
        fs::write(&path, b"reviewed archive").unwrap();
        let artifact = Artifact {
            file: path.clone(),
            sha256: format!("{:x}", Sha256::digest(b"reviewed archive")),
            version: "v22.19.0".into(),
        };

        let mut verified = verified_file(&artifact).expect("verified handle");
        fs::rename(&path, root.join("reviewed.tar.gz")).expect("move reviewed path");
        fs::write(&path, b"replacement archive").expect("replace path");
        let mut body = Vec::new();
        verified
            .read_to_end(&mut body)
            .expect("read verified handle");

        assert_eq!(body, b"reviewed archive");
        fs::remove_dir_all(root).unwrap();
    }
}

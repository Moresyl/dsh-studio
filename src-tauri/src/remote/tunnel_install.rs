//! Pinned tunnel artifacts, verified before caching, extracting or executing.

use std::borrow::Cow;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

pub const VERSION: &str = "2026.9.3";
const MAX_BINARY: usize = 128 * 1024 * 1024;
static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Copy)]
struct Asset {
    name: &'static str,
    sha256: &'static str,
    bytes: usize,
    archive: bool,
}

pub struct Installed {
    pub binary: PathBuf,
    pub config: PathBuf,
}

fn asset(os: &str, arch: &str) -> Result<Asset> {
    let (name, sha256, bytes, archive) = match (os, arch) {
        ("windows", "x86_64") => (
            "cloudflared-windows-amd64.exe",
            "f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2",
            55366080,
            false,
        ),
        ("linux", "x86_64") => (
            "cloudflared-linux-amd64",
            "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2",
            40122749,
            false,
        ),
        ("linux", "aarch64") => (
            "cloudflared-linux-arm64",
            "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d",
            37685657,
            false,
        ),
        ("macos", "x86_64") => (
            "cloudflared-darwin-amd64.tgz",
            "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977",
            21740193,
            true,
        ),
        ("macos", "aarch64") => (
            "cloudflared-darwin-arm64.tgz",
            "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095",
            19784166,
            true,
        ),
        _ => {
            return Err(failure(
                "no verified tunnel artifact is available for this platform",
            ))
        }
    };
    Ok(Asset {
        name,
        sha256,
        bytes,
        archive,
    })
}

/// Dropping this future cancels an unfinished download. No partial download is
/// written to disk. Final promotion contains only fully verified bytes.
pub async fn ensure_cloudflare(mut progress: impl FnMut(u64, u64) + Send) -> Result<Installed> {
    let _install = INSTALL.lock().await;
    let spec = asset(std::env::consts::OS, std::env::consts::ARCH)?;
    let tools = crate::paths::tools_dir();
    std::fs::create_dir_all(&tools).map_err(|_| failure("could not create the tools directory"))?;
    let metadata = std::fs::symlink_metadata(&tools)
        .map_err(|_| failure("could not inspect the tools directory"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure("the tools directory must be an ordinary directory"));
    }
    let root = tools
        .canonicalize()
        .map_err(|_| failure("could not resolve the tools directory"))?
        .join("cloudflared")
        .join(VERSION)
        .join(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    let cached_root = root.clone();
    let cached = tokio::task::spawn_blocking(move || cached(&cached_root, spec))
        .await
        .map_err(|_| failure("could not inspect the tunnel cache"))??;
    if let Some(installed) = cached {
        progress(spec.bytes as u64, spec.bytes as u64);
        return Ok(installed);
    }
    let client = crate::node::http::client()?;
    let url = format!(
        "https://github.com/cloudflare/cloudflared/releases/download/{VERSION}/{}",
        spec.name
    );
    let bytes = download(&client, &url, spec, &mut progress).await?;
    tokio::task::spawn_blocking(move || install(&root, spec, &bytes))
        .await
        .map_err(|_| failure("could not prepare the tunnel program"))?
}

async fn download(
    client: &reqwest::Client,
    url: &str,
    spec: Asset,
    progress: &mut (impl FnMut(u64, u64) + Send),
) -> Result<Vec<u8>> {
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|_| failure("could not download the tunnel program"))?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|bytes| bytes != spec.bytes as u64)
    {
        return Err(failure(
            "the tunnel download has an unexpected status or length",
        ));
    }
    let mut bytes = Vec::with_capacity(spec.bytes);
    progress(0, spec.bytes as u64);
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), response.chunk())
        .await
        .map_err(|_| failure("the tunnel download stopped making progress"))?
        .map_err(|_| failure("the tunnel download was interrupted"))?
    {
        if bytes.len().saturating_add(chunk.len()) > spec.bytes {
            return Err(failure("the tunnel download exceeds its verified size"));
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len() as u64, spec.bytes as u64);
    }
    verify(spec, &bytes)?;
    Ok(bytes)
}

fn failure(message: &str) -> Error {
    Error::RemoteTunnel(message.into())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn verify(spec: Asset, bytes: &[u8]) -> Result<()> {
    if bytes.len() != spec.bytes || digest(bytes) != spec.sha256 {
        return Err(failure(
            "the tunnel artifact failed its size or SHA-256 check",
        ));
    }
    Ok(())
}

fn regular(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            Ok(true)
        }
        Ok(_) => Err(failure(
            "a tunnel cache file was replaced by an unsafe file type",
        )),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(failure("could not read the tunnel cache")),
    }
}

fn check_ancestors(path: &Path) -> Result<()> {
    for parent in path.ancestors() {
        match std::fs::symlink_metadata(parent) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(failure("the tunnel cache must use ordinary directories")),
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(failure("could not inspect the tunnel cache directory")),
        }
    }
    Ok(())
}

fn binary_path(root: &Path, spec: Asset) -> PathBuf {
    root.join(if spec.name.ends_with(".exe") {
        "cloudflared.exe"
    } else {
        "cloudflared"
    })
}

fn cached(root: &Path, spec: Asset) -> Result<Option<Installed>> {
    check_ancestors(root)?;
    let source = if spec.archive {
        root.join(spec.name)
    } else {
        binary_path(root, spec)
    };
    if !regular(&source)? {
        return Ok(None);
    }
    let bytes = match crate::bounded_file::read(&source, spec.bytes) {
        Ok(bytes) if verify(spec, &bytes).is_ok() => bytes,
        _ => return Ok(None),
    };
    // On macOS the pinned digest belongs to the archive. Revalidate and decode
    // it on reuse; a mutable local digest marker is not a trust anchor.
    install(root, spec, &bytes).map(Some)
}

fn install(root: &Path, spec: Asset, bytes: &[u8]) -> Result<Installed> {
    verify(spec, bytes)?;
    let executable = decode(spec, bytes)?;
    check_ancestors(root)?;
    std::fs::create_dir_all(root).map_err(|_| failure("could not create the tunnel cache"))?;
    let binary = binary_path(root, spec);
    let config = root.join("empty.yml");
    let exists = regular(&binary)?;
    regular(&config)?;
    if spec.archive {
        let archive = root.join(spec.name);
        regular(&archive)?;
        crate::atomic::write(&archive, bytes)
            .map_err(|_| failure("could not save the verified tunnel archive"))?;
    }
    let matches = exists
        && crate::bounded_file::read(&binary, MAX_BINARY)
            .is_ok_and(|old| old == executable.as_ref());
    #[cfg(unix)]
    let matches = matches && {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(&binary).is_ok_and(|m| m.permissions().mode() & 0o100 != 0)
    };
    if !matches {
        write_executable(&binary, &executable)?;
    }
    crate::atomic::write(&config, b"{}\n")
        .map_err(|_| failure("could not write the isolated tunnel configuration"))?;
    Ok(Installed { binary, config })
}

fn write_executable(path: &Path, bytes: &[u8]) -> Result<()> {
    let (temporary, mut file) =
        crate::atomic::stage(path).map_err(|_| failure("could not stage the tunnel program"))?;
    let written = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o700))?;
        }
        file.sync_all()?;
        drop(file);
        crate::atomic::replace(&temporary, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written.map_err(|_| failure("could not atomically install the tunnel program"))
}

fn decode(spec: Asset, bytes: &[u8]) -> Result<Cow<'_, [u8]>> {
    if !spec.archive {
        return Ok(Cow::Borrowed(bytes));
    }
    let decoded = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoded);
    let mut executable = None;
    for entry in archive
        .entries()
        .map_err(|_| failure("the tunnel archive is unreadable"))?
    {
        let mut entry = entry.map_err(|_| failure("the tunnel archive is unreadable"))?;
        let path = entry
            .path()
            .map_err(|_| failure("the tunnel archive has an invalid path"))?;
        if path.as_ref() != Path::new("cloudflared")
            || !entry.header().entry_type().is_file()
            || executable.is_some()
        {
            return Err(failure(
                "the tunnel archive must contain only one regular cloudflared file",
            ));
        }
        if entry.size() == 0 || entry.size() > MAX_BINARY as u64 {
            return Err(failure("the unpacked tunnel program has an invalid size"));
        }
        let mut body = Vec::new();
        (&mut entry)
            .take(MAX_BINARY as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|_| failure("the tunnel archive is truncated"))?;
        if body.is_empty() || body.len() > MAX_BINARY {
            return Err(failure(
                "the unpacked tunnel program exceeds its size limit",
            ));
        }
        executable = Some(body);
    }
    executable
        .map(Cow::Owned)
        .ok_or_else(|| failure("the tunnel archive contains no program"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn root() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "studio-tunnel-install-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        path.canonicalize().unwrap()
    }

    fn spec(bytes: &[u8], archive: bool) -> Asset {
        Asset {
            name: if archive {
                "fixture.tgz"
            } else {
                "fixture.exe"
            },
            sha256: Box::leak(digest(bytes).into_boxed_str()),
            bytes: bytes.len(),
            archive,
        }
    }

    fn archive(entries: &[(&str, tar::EntryType, &[u8])]) -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for (path, kind, body) in entries {
            let mut header = tar::Header::new_gnu();
            header.as_mut_bytes()[..path.len()].copy_from_slice(path.as_bytes());
            header.set_entry_type(*kind);
            header.set_size(body.len() as u64);
            header.set_mode(0o700);
            header.set_cksum();
            tar.append(&header, *body).unwrap();
        }
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(&tar.into_inner().unwrap()).unwrap();
        gzip.finish().unwrap()
    }

    #[test]
    fn supported_platforms_have_distinct_pinned_artifacts() {
        let mut names = std::collections::HashSet::new();
        for (os, arch) in [
            ("windows", "x86_64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("macos", "x86_64"),
            ("macos", "aarch64"),
        ] {
            let asset = asset(os, arch).unwrap();
            assert!(names.insert(asset.name));
            assert_eq!(asset.sha256.len(), 64);
            assert!(asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(asset.bytes > 0 && asset.bytes < MAX_BINARY);
            assert_eq!(asset.archive, os == "macos");
        }
        assert!(asset("windows", "aarch64").is_err());
        assert!(asset("../escape", "x86_64").is_err());
    }

    #[test]
    fn raw_cache_is_verified_and_failed_install_preserves_old_program() {
        let root = root();
        let bytes = b"program";
        let spec = spec(bytes, false);
        let installed = install(&root, spec, bytes).unwrap();
        assert_eq!(std::fs::read(&installed.config).unwrap(), b"{}\n");
        assert!(cached(&root, spec).unwrap().is_some());
        assert!(install(&root, spec, b"corrupt").is_err());
        assert_eq!(std::fs::read(&installed.binary).unwrap(), bytes);
        std::fs::write(&installed.binary, b"tampered").unwrap();
        assert!(cached(&root, spec).unwrap().is_none());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_cache_repairs_program_only_from_verified_archive() {
        let root = root();
        let bytes = archive(&[("cloudflared", tar::EntryType::Regular, b"program")]);
        let spec = spec(&bytes, true);
        let installed = install(&root, spec, &bytes).unwrap();
        std::fs::write(&installed.binary, b"tampered").unwrap();
        assert!(cached(&root, spec).unwrap().is_some());
        assert_eq!(std::fs::read(&installed.binary).unwrap(), b"program");
        std::fs::write(root.join(spec.name), b"corrupt").unwrap();
        assert!(cached(&root, spec).unwrap().is_none());
        assert_eq!(std::fs::read(&installed.binary).unwrap(), b"program");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archives_reject_paths_links_duplicates_and_empty_programs() {
        let fixtures = [
            archive(&[]),
            archive(&[("cloudflared", tar::EntryType::Regular, b"")]),
            archive(&[("../cloudflared", tar::EntryType::Regular, b"program")]),
            archive(&[("cloudflared", tar::EntryType::Symlink, b"")]),
            archive(&[("cloudflared", tar::EntryType::Link, b"")]),
            archive(&[
                ("cloudflared", tar::EntryType::Regular, b"one"),
                ("cloudflared", tar::EntryType::Regular, b"two"),
            ]),
            b"not gzip".to_vec(),
        ];
        for bytes in fixtures {
            assert!(decode(spec(&bytes, true), &bytes).is_err());
        }
    }

    #[test]
    fn cache_rejects_non_file_targets_without_replacing_them() {
        let root = root();
        let spec = spec(b"program", false);
        let binary = binary_path(&root, spec);
        std::fs::create_dir(&binary).unwrap();
        assert!(install(&root, spec, b"program").is_err());
        assert!(binary.is_dir());
        assert!(check_ancestors(&root).is_ok());
        let file = root.join("file");
        std::fs::write(&file, b"keep").unwrap();
        assert!(check_ancestors(&file.join("child")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn download_checks_http_status_length_and_digest() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        crate::node::http::ensure_crypto_provider();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for (reply, valid) in [
            ("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nprogram", true),
            (
                "HTTP/1.1 404 Not Found\r\nContent-Length: 7\r\n\r\nprogram",
                false,
            ),
            (
                "HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nprogram!",
                false,
            ),
            ("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\nshort", false),
            ("HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\ncorrupt", false),
            (
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8\r\nprogram!\r\n0\r\n\r\n",
                false,
            ),
            ("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nshort", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                socket.read(&mut request).await.unwrap();
                socket.write_all(reply.as_bytes()).await.unwrap();
            });
            let mut progress = Vec::new();
            let result = download(
                &client,
                &url,
                spec(b"program", false),
                &mut |done, total| progress.push((done, total)),
            )
            .await;
            assert_eq!(result.is_ok(), valid);
            if valid {
                assert_eq!(result.unwrap(), b"program");
                assert_eq!(progress.last(), Some(&(7, 7)));
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancelling_a_download_closes_the_unfinished_connection() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        crate::node::http::ensure_crypto_provider();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (started, ready) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\np")
                .await
                .unwrap();
            started.send(()).unwrap();
            // The response intentionally never completes. Cancellation must
            // release it without waiting for the network idle timeout.
            match tokio::time::timeout(Duration::from_secs(5), socket.read(&mut request)).await {
                Ok(Ok(0) | Err(_)) => {}
                other => panic!("cancelled download retained its connection: {other:?}"),
            }
        });
        let task = tokio::spawn(async move {
            download(&client, &url, spec(b"program", false), &mut |_, _| {}).await
        });
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        server.await.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn cache_rejects_symlink_files_and_directories() {
        use std::os::unix::fs::symlink;
        let root = root();
        let target = root.join("target");
        std::fs::write(&target, b"program").unwrap();
        let spec = spec(b"program", false);
        symlink(&target, binary_path(&root, spec)).unwrap();
        assert!(cached(&root, spec).is_err());
        assert!(install(&root, spec, b"program").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"program");
        let alias = root.join("alias");
        symlink(&root, &alias).unwrap();
        assert!(check_ancestors(&alias.join("child")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

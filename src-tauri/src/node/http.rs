//! The one HTTPS client in this application that does not go through Node.
//!
//! Everything else reaches the network through [`crate::fetch`], which runs
//! `node -e` and borrows Node's own `fetch`. That is a deliberate trade and a
//! good one — requests inherit the proxy settings and certificate store the
//! user's Node already works with, for free. It has exactly one blind spot, and
//! this file exists to cover it: it cannot fetch Node.
//!
//! Both properties are kept here by other means rather than given up. reqwest
//! reads the same `HTTPS_PROXY`/`NO_PROXY` variables on its own, and the
//! `rustls-no-provider` feature brings in `rustls-platform-verifier`, which
//! validates certificates against the operating system's own trust store
//! instead of a root list baked into the binary. So a machine behind a
//! TLS-inspecting corporate proxy downloads Node here for the same reason its
//! browser can reach the same URL.

use std::path::Path;
use std::time::Duration;

use reqwest::Client;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::error::{Error, Result};

const USER_AGENT: &str = concat!("dsh-studio/", env!("CARGO_PKG_VERSION"));

/// Long enough for a mirror on the other side of the world to answer, short
/// enough that a black-holed route is not mistaken for a slow one.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Bounds a metadata GET end to end. Archives use separate header and idle
/// deadlines below so a slow, progressing hotel download remains valid while a
/// peer that stops producing bytes cannot hold the install forever.
const METADATA_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_METADATA_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const DOWNLOAD_HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_REDIRECTS: usize = 5;

/// Give rustls its cipher-suite implementation, once per process.
///
/// `reqwest`'s `rustls-no-provider` feature leaves that choice to the
/// application. `tauri-plugin-updater` — the other user of this same reqwest
/// build — installs ring as the process default the first time it makes a
/// request, so this does the same thing, and the `Result` is dropped on purpose:
/// installing twice fails, and whichever of the two got there first has already
/// installed the provider this one was going to.
pub(crate) fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

pub fn client() -> Result<Client> {
    ensure_crypto_provider();
    Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many Node download redirects")
            } else if attempt.url().scheme() != "https" {
                attempt.error("Node downloads may not redirect away from HTTPS")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|cause| Error::Network(format!("no HTTPS client could be built: {cause}")))
}

/// GET a small text document — a release index, a checksum list.
pub async fn text(client: &Client, url: &str) -> Result<String> {
    ensure_https(url)?;
    let mut response = client
        .get(url)
        .timeout(METADATA_TIMEOUT)
        .send()
        .await
        .map_err(|cause| {
            Error::Network(format!("{url} could not be reached: {}", reason(&cause)))
        })?;

    let status = response.status();
    if !status.is_success() {
        return Err(Error::Network(format!("{url} answered {status}")));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_METADATA_BYTES)
    {
        return Err(Error::Network(format!(
            "{url} sent more than 4 MiB of metadata"
        )));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|cause| Error::Network(format!("{url} sent an unreadable reply: {cause}")))?
    {
        let size = bounded_size(body.len() as u64, chunk.len() as u64, MAX_METADATA_BYTES)
            .ok_or_else(|| Error::Network(format!("{url} sent more than 4 MiB of metadata")))?;
        body.reserve(size.saturating_sub(body.len() as u64) as usize);
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body)
        .map_err(|cause| Error::Network(format!("{url} sent an unreadable reply: {cause}")))
}

/// Stream `url` into `destination`, returning the SHA-256 of what arrived.
///
/// The hash is computed from the bytes on their way to disk rather than by
/// reading the file back: it costs nothing, and it means the digest is of what
/// was actually received even if something else touches the file afterwards.
///
/// `progress` is called with the running byte count and the total when the
/// server declared one. It is called on every chunk, so throttling is the
/// caller's business — they know what they are feeding.
pub async fn download<P>(
    client: &Client,
    url: &str,
    destination: &Path,
    mut progress: P,
) -> Result<String>
where
    P: FnMut(u64, Option<u64>),
{
    ensure_https(url)?;
    let mut response = tokio::time::timeout(DOWNLOAD_HEADER_TIMEOUT, client.get(url).send())
        .await
        .map_err(|_| Error::Network(format!("{url} did not answer within 30 seconds")))?
        .map_err(|cause| {
            Error::Network(format!("{url} could not be reached: {}", reason(&cause)))
        })?;

    let status = response.status();
    if !status.is_success() {
        return Err(Error::Network(format!("{url} answered {status}")));
    }
    let total = response.content_length();
    if total.is_some_and(|size| size > MAX_ARCHIVE_BYTES) {
        return Err(Error::Network(format!(
            "the download from {url} exceeds the 256 MiB safety limit"
        )));
    }

    let mut file = tokio::fs::File::create(destination)
        .await
        .map_err(|cause| Error::Network(format!("nowhere to save the download: {cause}")))?;
    let mut digest = Sha256::new();
    let mut received: u64 = 0;
    progress(received, total);

    while let Some(chunk) = tokio::time::timeout(DOWNLOAD_IDLE_TIMEOUT, response.chunk())
        .await
        .map_err(|_| {
            Error::Network(format!(
                "the download from {url} produced no data for 90 seconds"
            ))
        })?
        .map_err(|cause| Error::Network(format!("the download from {url} broke off: {cause}")))?
    {
        received =
            bounded_size(received, chunk.len() as u64, MAX_ARCHIVE_BYTES).ok_or_else(|| {
                Error::Network(format!(
                    "the download from {url} exceeds the 256 MiB safety limit"
                ))
            })?;
        digest.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|cause| Error::Network(format!("the download could not be saved: {cause}")))?;
        progress(received, total);
    }

    // Without this the last chunks can still be in the buffer when the extractor
    // opens the file, and a truncated archive fails in a way that looks nothing
    // like the missing flush that caused it.
    file.flush()
        .await
        .map_err(|cause| Error::Network(format!("the download could not be saved: {cause}")))?;

    Ok(hex(&digest.finalize()))
}

fn ensure_https(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| Error::Network("Node download URL is invalid".into()))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(Error::Network(
            "Node downloads require a credential-free HTTPS URL".into(),
        ));
    }
    Ok(())
}

fn bounded_size(current: u64, incoming: u64, maximum: u64) -> Option<u64> {
    current
        .checked_add(incoming)
        .filter(|combined| *combined <= maximum)
}

/// The innermost cause of a reqwest failure.
///
/// reqwest's own `Display` stops at "error sending request for url (…)", which
/// names the URL the caller already knows and hides the DNS or TLS failure that
/// is the whole answer.
fn reason(failure: &reqwest::Error) -> String {
    let mut cause: &dyn std::error::Error = failure;
    while let Some(inner) = cause.source() {
        cause = inner;
    }
    cause.to_string()
}

const HEX: [u8; 16] = *b"0123456789abcdef";

/// Lower-case hex, to compare against a published `SHASUMS256.txt` line.
fn hex(digest: &[u8]) -> String {
    let mut text = String::with_capacity(digest.len() * 2);
    for byte in digest {
        text.push(HEX[usize::from(byte >> 4)] as char);
        text.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    text
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use sha2::{Digest, Sha256};

    use super::{bounded_size, client, download, ensure_https, hex, text};

    #[test]
    fn node_sources_are_exactly_credential_free_https() {
        assert!(ensure_https("https://nodejs.org/dist/index.json").is_ok());
        for unsafe_url in [
            "http://nodejs.org/dist/index.json",
            "https://token@nodejs.org/dist/index.json",
            "not a URL",
        ] {
            assert!(ensure_https(unsafe_url).is_err(), "accepted {unsafe_url}");
        }
    }

    #[tokio::test]
    async fn node_network_helpers_refuse_plain_http_before_connecting() {
        let client = client().expect("client");
        assert!(text(&client, "http://127.0.0.1/index.json")
            .await
            .expect_err("HTTP metadata must be refused")
            .to_string()
            .contains("credential-free HTTPS"));
        assert!(download(
            &client,
            "http://127.0.0.1/node.zip",
            Path::new("unused"),
            |_, _| {}
        )
        .await
        .expect_err("HTTP archives must be refused")
        .to_string()
        .contains("credential-free HTTPS"));
    }

    #[test]
    fn byte_limits_reject_overflow_and_the_first_byte_past_the_ceiling() {
        assert_eq!(bounded_size(3, 2, 5), Some(5));
        assert_eq!(bounded_size(5, 1, 5), None);
        assert_eq!(bounded_size(u64::MAX, 1, u64::MAX), None);
    }

    #[test]
    fn spells_a_digest_the_way_the_published_checksums_do() {
        // The empty string's SHA-256, as `sha256sum` prints it: lower case, no
        // separators. Anything else would never match a published line.
        assert_eq!(
            hex(&Sha256::digest(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}

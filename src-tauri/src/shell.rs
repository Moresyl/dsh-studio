//! The shell's static file server.
//!
//! Why this exists at all: dsh 0.1.2+ guards its web surface with a
//! per-boot token exchanged for a `SameSite=Strict` session cookie. WKWebView
//! refuses to hold or send that cookie inside a *cross-site* frame — and the
//! harness iframe was cross-site because the shell lived on `tauri://localhost`
//! while the harness serves on `http://127.0.0.1:<port>`. The result was the
//! window wedged on the harness's `dsh web authentication required` page.
//!
//! SameSite's "site" is scheme + host; ports do not count. So the shell serves
//! its own compiled frontend from `http://127.0.0.1:<port>` too, and from the
//! harness's point of view the embedded frame is now same-site: the bootstrap
//! URL the harness prints is opened in the frame verbatim, the 303 + cookie
//! exchange completes, and every subsequent request carries the cookie —
//! exactly the ceremony a browser tab performs, with no bypass and no proxy.
//!
//! What it does not do matters as much as what it does: it serves the static
//! bundle the app was built with and nothing else. The harness's traffic never
//! touches this server; the loopback-origin proxy that did that was retired
//! once the same-site approach worked.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::error::{Error, Result};

const ADDRESS: &str = "127.0.0.1";
/// Bound the headers of a request the shell's own bundle can ask for.
const REQUEST_BYTES: usize = 4096;
/// The frontend is compiled, minified and local; anything larger is not this
/// server talking to itself.
const BODY_BYTES: usize = crate::bounded_file::CONTROL_BYTES;

/// The shell's static server, alive until dropped.
///
/// `start` returns the bound address alongside the handle because the port is
/// chosen by the OS and the windows need to know it before they load.
#[derive(Debug)]
pub struct ShellServer {
    port: u16,
    stopped: Arc<AtomicBool>,
    _root: PathBuf,
}

impl ShellServer {
    /// Bind an ephemeral loopback port and serve `root` until dropped.
    pub fn start(root: PathBuf) -> Result<(Self, String)> {
        if !root.join("index.html").is_file() {
            return Err(Error::Install(format!(
                "the compiled shell has no entry point at {}",
                root.join("index.html").display()
            )));
        }
        let listener = TcpListener::bind((ADDRESS, 0))
            .map_err(|cause| Error::Install(format!("the shell could not bind: {cause}")))?;
        let port = listener
            .local_addr()
            .map_err(|cause| Error::Install(format!("the shell address is unreadable: {cause}")))?
            .port();
        let origin = format!("http://{ADDRESS}:{port}");
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_thread = Arc::clone(&stopped);
        let root_thread = root.clone();

        std::thread::Builder::new()
            .name("shell-static".into())
            .spawn(move || {
                for incoming in listener.incoming() {
                    if stopped_thread.load(Ordering::Relaxed) {
                        break;
                    }
                    let Ok(stream) = incoming else { continue };
                    let root = root_thread.clone();
                    std::thread::spawn(move || {
                        let _ = serve(stream, &root);
                    });
                }
            })
            .map_err(|cause| {
                Error::Install(format!("the shell server could not start: {cause}"))
            })?;

        Ok((
            Self {
                port,
                stopped,
                _root: root,
            },
            origin,
        ))
    }
}

impl Drop for ShellServer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        // A final connection unblocks the accept loop, which is parked on a
        // blocking read it cannot otherwise be woken from.
        let _ = std::net::TcpStream::connect((ADDRESS, self.port));
    }
}

fn serve(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;

    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while head.len() < REQUEST_BYTES {
        let read = stream.read(&mut byte)?;
        if read == 0 {
            return Ok(());
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
    }

    let request = String::from_utf8_lossy(&head);
    let Some(request_line) = request.lines().next() else {
        return Ok(());
    };
    let mut parts = request_line.split_whitespace();
    if parts.next() != Some("GET") {
        reply(&mut stream, 405, "method not allowed", "text/plain")?;
        return Ok(());
    }
    let Some(raw_path) = parts.next() else {
        return Ok(());
    };
    let path = raw_path.split(['?', '#']).next().unwrap_or("/");

    // The bundle is compiled with absolute paths, so the only entry point the
    // server is asked for is "/". Anything else under the root is also served
    // (hashed assets, source maps), and everything outside it is refused. Both
    // the root and the target are canonicalised because macOS temp paths pass
    // through a symlink and a plain lexical prefix check would refuse them.
    let root = root
        .canonicalize()
        .unwrap_or_else(|_| root.to_path_buf());
    let relative = path.trim_start_matches('/');
    let candidate = if relative.is_empty() {
        root.join("index.html")
    } else {
        root.join(relative)
    };
    let canonical = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.clone());
    if !canonical.starts_with(&root) {
        reply(&mut stream, 403, "forbidden", "text/plain")?;
        return Ok(());
    }

    let body = match std::fs::read(&canonical) {
        Ok(body) => body,
        Err(_) => {
            reply(&mut stream, 404, "not found", "text/plain")?;
            return Ok(());
        }
    };
    if body.len() > BODY_BYTES {
        reply(&mut stream, 413, "asset too large", "text/plain")?;
        return Ok(());
    }

    let content_type = match canonical.extension().and_then(|ext| ext.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    };

    stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\ncontent-security-policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* ws://127.0.0.1:*; frame-src http://127.0.0.1:* http://localhost:*\r\naccess-control-allow-origin: *\r\ncache-control: no-store\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    )?;
    stream.write_all(&body)?;
    stream.flush()?;
    Ok(())
}

fn reply(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
    content_type: &str,
) -> std::io::Result<()> {
    let body = message.as_bytes();
    stream.write_all(
        format!(
            "HTTP/1.1 {status} {message}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    Ok(())
}

/// The loopback origin the shell windows load, managed as Tauri state.
pub struct ShellOrigin(pub String);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_root_without_an_entry_point_is_refused() {
        let root = std::env::temp_dir().join("shell-server-empty-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let err = ShellServer::start(root.clone()).expect_err("no index.html must fail");
        assert!(err.to_string().contains("no entry point"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn index_and_a_nested_asset_round_trip() {
        let root = std::env::temp_dir().join(format!(
            "shell-server-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), b"<html>shell</html>").unwrap();
        std::fs::write(root.join("assets").join("app.js"), b"console.log(1)").unwrap();

        let (server, origin) = ShellServer::start(root.clone()).unwrap();
        assert!(origin.starts_with("http://127.0.0.1:"));

        let index = reqwest_like_get(&format!("{origin}/"));
        assert!(index.contains("200 OK"));
        assert!(index.contains("<html>shell</html>"));

        let asset = reqwest_like_get(&format!("{origin}/assets/app.js"));
        assert!(asset.contains("200 OK"));
        assert!(asset.contains("console.log(1)"));

        // Escaping the root is refused.
        // Escaping the root is refused: the resolved path falls outside the
        // bundle, which the server answers with 403 when the file happens to
        // exist and 404 when it does not — either way it is never served.
        let forbidden = reqwest_like_get(&format!("{origin}/../Cargo.toml"));
        assert!(forbidden.contains("403") || forbidden.contains("404"));

        // A missing file 404s.
        let missing = reqwest_like_get(&format!("{origin}/assets/none.js"));
        assert!(missing.contains("404"));

        drop(server);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Smallest correct GET the tests need; keeps this module free of an HTTP client dep.
    fn reqwest_like_get(raw: &str) -> String {
        let parsed = url::Url::parse(raw).unwrap();
        let host = parsed.host_str().unwrap().to_string();
        let port = parsed.port().unwrap();
        let path = parsed.path().to_string();
        let mut stream = TcpStream::connect((host.as_str(), port)).unwrap();
        stream
            .write_all(
                format!(
                    "GET {path} HTTP/1.1\r\nhost: {host}\r\nconnection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).unwrap();
        String::from_utf8_lossy(&out).to_string()
    }
}

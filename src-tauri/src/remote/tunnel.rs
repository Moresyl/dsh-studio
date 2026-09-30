//! Own a tunnel child and its output readers for one remote-access lifetime.
//! An advertised address is not a readiness check; callers must probe the
//! authenticated gateway through it before displaying a pairing link.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use proc_guard::ProcessGuard;
use tokio::io::{AsyncRead, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, watch};

use crate::error::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Cloudflare,
    Pinggy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Starting,
    Address(String),
    Exited(Option<i32>),
}

pub struct Tunnel {
    guard: Arc<ProcessGuard>,
    state: watch::Receiver<State>,
}

impl Tunnel {
    pub fn cloudflare(binary: &Path, config: &Path, port: u16) -> Result<Self> {
        if port == 0 {
            return Err(Error::RemoteTunnel("the local gateway has no port".into()));
        }
        let mut command = Command::new(binary);
        // The managed quick tunnel must not inherit a named tunnel, credentials
        // file or logging destination from an unrelated cloudflared setup.
        for (name, _) in std::env::vars_os() {
            let key = name.to_string_lossy().to_ascii_uppercase();
            if key.starts_with("TUNNEL_") || key.starts_with("CLOUDFLARED_") {
                command.env_remove(name);
            }
        }
        command.args(["tunnel", "--config"]).arg(config).args([
            "--no-autoupdate",
            "--management-diagnostics=false",
            "--loglevel",
            "info",
            "--output",
            "json",
            "--url",
            &format!("http://127.0.0.1:{port}"),
        ]);
        Self::spawn(command, Provider::Cloudflare)
    }

    pub fn pinggy(ssh: &Path, identity: &Path, known_hosts: &Path, port: u16) -> Result<Self> {
        if port == 0 {
            return Err(Error::RemoteTunnel("the local gateway has no port".into()));
        }
        let mut command = Command::new(ssh);
        command
            .args([
                "-T",
                "-F",
                "none",
                "-p",
                "443",
                "-R",
                &format!("0:127.0.0.1:{port}"),
                "-i",
            ])
            .arg(identity)
            .args([
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "BatchMode=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ConnectTimeout=15",
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
            ])
            .arg(format!(
                "UserKnownHostsFile=\"{}\"",
                known_hosts
                    .to_string_lossy()
                    .replace('\\', "/")
                    .replace('"', "\\\"")
            ))
            .arg("studio@free.pinggy.io");
        Self::spawn(command, Provider::Pinggy)
    }

    fn spawn(mut command: Command, provider: Provider) -> Result<Self> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let guard = Arc::new(ProcessGuard::new().map_err(Error::ProcessGuard)?);
        let mut child = guard.spawn(&mut command).map_err(Error::Spawn)?;
        let pid = child
            .id()
            .ok_or_else(|| Error::RemoteTunnel("tunnel process did not start".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::RemoteTunnel("tunnel output is unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::RemoteTunnel("tunnel output is unavailable".into()))?;
        let (updates, state) = watch::channel(State::Starting);
        let (addresses, mut received) = mpsc::channel(2);
        let out_task = tokio::spawn(read_addresses(stdout, provider, addresses.clone()));
        let err_task = tokio::spawn(read_addresses(stderr, provider, addresses));
        let owner = Arc::clone(&guard);
        tokio::spawn(async move {
            let mut output_open = true;
            let exit = loop {
                tokio::select! {
                    biased;
                    exit = child.wait() => break exit,
                    address = received.recv(), if output_open => {
                        if let Some(address) = address {
                            if matches!(*updates.borrow(), State::Starting) {
                                updates.send_replace(State::Address(address));
                            }
                        } else {
                            output_open = false;
                        }
                    }
                }
            };
            let _ = owner.finish(pid);
            out_task.abort();
            err_task.abort();
            let _ = out_task.await;
            let _ = err_task.await;
            updates.send_replace(State::Exited(exit.ok().and_then(|status| status.code())));
        });
        Ok(Self { guard, state })
    }

    pub fn subscribe(&self) -> watch::Receiver<State> {
        self.state.clone()
    }

    pub fn stop(&self) -> Result<()> {
        self.guard.terminate_all().map_err(Error::ProcessGuard)
    }

    pub async fn address(&mut self, budget: Duration) -> Result<String> {
        let result = tokio::time::timeout(budget, async {
            loop {
                match self.state.borrow().clone() {
                    State::Address(url) => return Ok(url),
                    State::Exited(_) => {
                        return Err(Error::RemoteTunnel(
                            "tunnel exited before publishing an address".into(),
                        ))
                    }
                    State::Starting => {}
                }
                self.state
                    .changed()
                    .await
                    .map_err(|_| Error::RemoteTunnel("tunnel process stopped".into()))?;
            }
        })
        .await;
        match result {
            Ok(result) => result,
            Err(_) => {
                let _ = self.stop();
                Err(Error::RemoteTunnel(
                    "tunnel did not publish an address before the timeout".into(),
                ))
            }
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.guard.terminate_all();
    }
}

async fn read_addresses<R: AsyncRead + Unpin>(
    reader: R,
    provider: Provider,
    addresses: mpsc::Sender<String>,
) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let mut offered = false;
    while crate::child_output::next_line(&mut reader, &mut line)
        .await
        .unwrap_or(false)
    {
        if !offered {
            if let Some(url) = advertised_url(&String::from_utf8_lossy(&line), provider) {
                offered = true;
                let _ = addresses.send(url).await;
            }
        }
    }
}

fn advertised_url(line: &str, provider: Provider) -> Option<String> {
    for (offset, _) in line.match_indices("https://") {
        let candidate = line[offset..]
            .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '|' | '\\'))
            .next()?
            .trim_end_matches([',', ')', ']']);
        let Ok(url) = url::Url::parse(candidate) else {
            continue;
        };
        let Some(host) = url.host_str() else {
            continue;
        };
        let allowed = match provider {
            Provider::Cloudflare => host
                .strip_suffix(".trycloudflare.com")
                .is_some_and(|label| label != "api" && dns_label(label)),
            Provider::Pinggy => [".pinggy.link", ".pinggy-free.link", ".pinggy.online"]
                .iter()
                .any(|suffix| {
                    host.strip_suffix(suffix)
                        .is_some_and(|prefix| prefix.split('.').all(dns_label))
                }),
        };
        if allowed
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
        {
            return Some(url.origin().ascii_serialization());
        }
    }
    None
}

fn dns_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_refuse_a_missing_local_port_before_spawning() {
        let missing = Path::new("missing-program");
        assert!(Tunnel::cloudflare(missing, missing, 0).is_err());
        assert!(Tunnel::pinggy(missing, missing, missing, 0).is_err());
    }

    #[tokio::test]
    #[ignore = "explicit live temporary tunnel against an empty unauthorized fixture"]
    async fn live_cloudflare_probes_an_empty_fixture_and_reclaims_the_process() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let binary =
            std::env::var_os("DSH_STUDIO_QA_CLOUDFLARED").expect("verified QA binary required");
        let config = std::env::var_os("DSH_STUDIO_QA_TUNNEL_CONFIG")
            .expect("isolated empty config required");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fixture");
        let port = listener.local_addr().expect("address").port();
        let serving = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    let _ = socket.read(&mut buffer).await;
                    let _ = socket.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\nX-Studio-Tunnel-Fixture: empty\r\n\r\n").await;
                });
            }
        });
        let mut tunnel =
            Tunnel::cloudflare(Path::new(&binary), Path::new(&config), port).expect("start");
        let address = tunnel
            .address(Duration::from_secs(45))
            .await
            .expect("advertised address");
        let client = crate::node::http::client().expect("TLS client");
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                if let Ok(response) = client
                    .get(&address)
                    .timeout(Duration::from_secs(3))
                    .send()
                    .await
                {
                    if response.status() == 401
                        && response
                            .headers()
                            .get("x-studio-tunnel-fixture")
                            .is_some_and(|v| v == "empty")
                    {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        })
        .await
        .expect("public address must reach the empty local fixture");
        let state = tunnel.subscribe();
        drop(tunnel);
        exited(state).await;
        serving.abort();
        eprintln!("live tunnel: fixture 401 verified; owned process reaped");
    }

    #[test]
    fn parses_provider_addresses_without_accepting_lookalike_hosts_or_credentials() {
        assert_eq!(
            advertised_url(
                r#"{"message":"https://sample-name.trycloudflare.com"}"#,
                Provider::Cloudflare
            )
            .as_deref(),
            Some("https://sample-name.trycloudflare.com")
        );
        assert_eq!(
            advertised_url("http://skip https://sample.a.pinggy.link", Provider::Pinggy).as_deref(),
            Some("https://sample.a.pinggy.link")
        );
        for value in [
            "https://api.trycloudflare.com",
            "https://trycloudflare.com",
            "https://a.trycloudflare.com.evil.test",
            "https://evil.test/a.trycloudflare.com",
            "https://name:secret@a.trycloudflare.com",
            "https://a.trycloudflare.com:8080",
            "https://a.trycloudflare.com/path",
            "https://a.trycloudflare.com/?token=secret",
            "https://a.trycloudflare.com/#fragment",
            "https://-a.trycloudflare.com",
        ] {
            assert!(
                advertised_url(value, Provider::Cloudflare).is_none(),
                "{value}"
            );
        }
        assert!(advertised_url("https://a.pinggy.link", Provider::Cloudflare).is_none());
        assert!(advertised_url("https://a.trycloudflare.com", Provider::Pinggy).is_none());
    }

    fn fixture(mode: &str) -> Tunnel {
        let mut command = Command::new(std::env::current_exe().expect("test binary"));
        command
            .args([
                "--exact",
                "remote::tunnel::tests::child_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("DSH_STUDIO_TUNNEL_FIXTURE", mode);
        Tunnel::spawn(command, Provider::Cloudflare).expect("spawn")
    }

    async fn exited(mut state: watch::Receiver<State>) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if matches!(*state.borrow(), State::Exited(_)) {
                    return;
                }
                state.changed().await.expect("exit state");
            }
        })
        .await
        .expect("owned child exits");
    }

    #[tokio::test]
    async fn drop_reclaims_a_tunnel_after_it_publishes_an_address() {
        let mut tunnel = fixture("address");
        assert_eq!(
            tunnel
                .address(Duration::from_secs(5))
                .await
                .expect("address"),
            "https://qa-process.trycloudflare.com"
        );
        let state = tunnel.subscribe();
        drop(tunnel);
        exited(state).await;
    }

    #[tokio::test]
    async fn timeout_stops_a_silent_child() {
        let mut tunnel = fixture("silent");
        assert!(tunnel.address(Duration::from_millis(100)).await.is_err());
        exited(tunnel.subscribe()).await;
    }

    #[tokio::test]
    async fn child_failure_is_reported_without_repeating_its_output() {
        let mut tunnel = fixture("failure");
        let error = tunnel
            .address(Duration::from_secs(5))
            .await
            .expect_err("failed child");
        assert!(!error.to_string().contains("fixture-secret"));
        exited(tunnel.subscribe()).await;
    }

    #[test]
    #[ignore = "subprocess fixture invoked only by tunnel lifecycle tests"]
    fn child_fixture() {
        let Ok(mode) = std::env::var("DSH_STUDIO_TUNNEL_FIXTURE") else {
            return;
        };
        if mode == "failure" {
            eprintln!("fixture-secret");
            std::process::exit(7);
        }
        if mode == "address" {
            println!("https://qa-process.trycloudflare.com");
        }
        std::thread::sleep(Duration::from_secs(30));
    }
}

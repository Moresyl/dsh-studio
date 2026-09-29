//! Loopback authentication belongs to the gateway, never to the paired phone.

use std::net::SocketAddr;
use std::time::Duration;

use reqwest::header::SET_COOKIE;

use crate::error::{Error, Result};

// Deliberately neither Debug nor Serialize: this owns an upstream credential.
pub struct Upstream {
    pub address: SocketAddr,
    pub cookie: Option<String>,
}

impl From<SocketAddr> for Upstream {
    fn from(address: SocketAddr) -> Self {
        Self {
            address,
            cookie: None,
        }
    }
}

impl Upstream {
    pub async fn authenticate(origin: &str) -> Result<Self> {
        let address = super::upstream_from(origin)?;
        let url = url::Url::parse(origin).map_err(|_| Error::RemoteAuthentication)?;
        let tokens: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "token")
            .collect();
        if tokens.is_empty() {
            return Ok(address.into());
        }
        if tokens.len() != 1 || tokens[0].1.is_empty() || tokens[0].1.len() > 4096 {
            return Err(Error::RemoteAuthentication);
        }
        let mut exchange = url::Url::parse(&format!("http://{address}/"))
            .map_err(|_| Error::RemoteAuthentication)?;
        exchange
            .query_pairs_mut()
            .append_pair("token", &tokens[0].1);
        crate::node::ensure_crypto_provider();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| Error::RemoteAuthentication)?;
        // Do not include reqwest errors: their URL can contain the launch token.
        let response = client
            .get(exchange)
            .send()
            .await
            .map_err(|_| Error::RemoteAuthentication)?;
        if response.status() != reqwest::StatusCode::SEE_OTHER {
            return Err(Error::RemoteAuthentication);
        }
        let mut pairs = Vec::new();
        let mut total = 0usize;
        for header in response.headers().get_all(SET_COOKIE) {
            let value = header.to_str().map_err(|_| Error::RemoteAuthentication)?;
            let pair = value.split(';').next().unwrap_or_default();
            let (name, secret) = pair.split_once('=').ok_or(Error::RemoteAuthentication)?;
            if name.is_empty()
                || secret.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
                || !secret.bytes().all(
                    |b| matches!(b, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e),
                )
            {
                return Err(Error::RemoteAuthentication);
            }
            total = total.saturating_add(pair.len());
            if total > 8192 || pairs.len() >= 8 {
                return Err(Error::RemoteAuthentication);
            }
            pairs.push(pair.to_owned());
        }
        if pairs.is_empty() {
            return Err(Error::RemoteAuthentication);
        }
        Ok(Self {
            address,
            cookie: Some(pairs.join("; ")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn server(response: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!(
            "http://{}/ignored?other=omit&token=local%20secret",
            listener.local_addr().expect("addr")
        );
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = Vec::new();
            loop {
                let byte = socket.read_u8().await.expect("read");
                request.push(byte);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
                assert!(request.len() < 8192);
            }
            socket
                .write_all(response.as_bytes())
                .await
                .expect("response");
            String::from_utf8(request).expect("utf8")
        });
        (origin, task)
    }

    #[tokio::test]
    async fn exchanges_only_the_token_and_keeps_cookie_attributes_out_of_requests() {
        let (origin, task) = server("HTTP/1.1 303 See Other\r\nLocation: ./\r\nSet-Cookie: dsh-auth-test=v1.signed; HttpOnly; SameSite=Strict; Path=/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()).await;
        let upstream = Upstream::authenticate(&origin).await.expect("authenticate");
        assert_eq!(upstream.cookie.as_deref(), Some("dsh-auth-test=v1.signed"));
        let request = task.await.expect("task");
        assert!(
            request.starts_with("GET /?token=local+secret HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(!request.contains("other=omit"));
        assert!(request
            .to_lowercase()
            .contains(&format!("host: {}", upstream.address)));
    }

    #[tokio::test]
    async fn legacy_tokenless_origins_do_not_require_an_exchange() {
        let upstream = Upstream::authenticate("http://127.0.0.1:1")
            .await
            .expect("legacy");
        assert!(upstream.cookie.is_none());
    }

    #[tokio::test]
    async fn rejects_invalid_origins_and_tokens_without_disclosing_them() {
        for origin in [
            "https://127.0.0.1:1/?token=private-value",
            "http://user:private-value@127.0.0.1:1",
            "http://example.com/?token=private-value",
            "http://127.0.0.1:1/?token=private-value&token=second",
            "http://127.0.0.1:1/?token=",
            "bad-private-value",
        ] {
            let error = Upstream::authenticate(origin).await.err().expect("reject");
            assert!(!error.to_string().contains("private-value"));
        }
    }

    #[tokio::test]
    async fn rejects_refusal_missing_empty_unsafe_and_excessive_cookies() {
        let responses = [
            "HTTP/1.1 401 Unauthorized\r\n".to_owned(),
            "HTTP/1.1 200 OK\r\nSet-Cookie: auth=secret\r\n".into(),
            "HTTP/1.1 303 See Other\r\n".into(),
            "HTTP/1.1 303 See Other\r\nSet-Cookie: auth=\r\n".into(),
            "HTTP/1.1 303 See Other\r\nSet-Cookie: bad name=secret\r\n".into(),
            "HTTP/1.1 303 See Other\r\nSet-Cookie: auth=bad,secret\r\n".into(),
            format!(
                "HTTP/1.1 303 See Other\r\nSet-Cookie: auth={}\r\n",
                "x".repeat(8193)
            ),
            format!(
                "HTTP/1.1 303 See Other\r\n{}",
                "Set-Cookie: auth=secret\r\n".repeat(9)
            ),
        ];
        for response in responses {
            let (origin, task) = server(format!(
                "{response}Content-Length: 0\r\nConnection: close\r\n\r\n"
            ))
            .await;
            assert!(matches!(
                Upstream::authenticate(&origin).await,
                Err(Error::RemoteAuthentication)
            ));
            task.await.expect("task");
        }
    }

    #[tokio::test]
    async fn does_not_follow_bootstrap_redirects() {
        let destination = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let (origin, task) = server(format!("HTTP/1.1 303 See Other\r\nLocation: http://{}/capture\r\nSet-Cookie: auth=secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", destination.local_addr().expect("addr"))).await;
        assert!(Upstream::authenticate(&origin).await.is_ok());
        task.await.expect("task");
        assert!(
            tokio::time::timeout(Duration::from_millis(50), destination.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn connection_errors_do_not_include_the_bootstrap_url() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!(
            "http://{}/?token=private-value",
            listener.local_addr().expect("addr")
        );
        drop(listener);
        let error = Upstream::authenticate(&origin).await.err().expect("closed");
        assert!(!error.to_string().contains("private-value"));
        let remote = super::super::Remote::new();
        assert!(remote.open(&origin).await.is_err());
        assert!(!remote.status().open);
        assert!(remote.status().pairing_url.is_none());
        assert!(remote.status().devices.is_empty());
    }

    #[tokio::test]
    async fn bootstrap_exchange_times_out_when_the_runtime_stops_answering() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let origin = format!(
            "http://{}/?token=private-value",
            listener.local_addr().expect("addr")
        );
        let result = tokio::time::timeout(Duration::from_secs(15), Upstream::authenticate(&origin))
            .await
            .expect("authentication must have its own bounded timeout");
        assert!(matches!(result, Err(Error::RemoteAuthentication)));
    }
}

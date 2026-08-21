//! Host-owned, non-tracking plugin imagery.
//!
//! Catalog URLs never enter an `<img>` element. The native side resolves and
//! pins a public address, bounds the reply, decodes it as pixels, strips all
//! metadata by re-encoding a small PNG, and only then returns a data URL.

use std::io::Cursor;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use base64::Engine as _;
use image::ImageFormat;
use serde::Serialize;

use crate::error::{Error, Result};

const MAX_BODY: usize = 2 << 20;
const MAX_DIMENSION: u32 = 4_096;
const MAX_PIXELS: u64 = 16_000_000;
const OUTPUT_DIMENSION: u32 = 96;
const MAX_REDIRECTS: usize = 2;

#[derive(Clone, Debug)]
pub struct Candidate {
    pub url: String,
    pub allowed_hosts: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub data_url: String,
}

pub async fn fetch(candidate: &Candidate) -> Result<Asset> {
    crate::node::ensure_crypto_provider();
    let allowed = normalized_hosts(&candidate.allowed_hosts)?;
    let mut next = safe_url(&candidate.url, &allowed)?;

    for redirects in 0..=MAX_REDIRECTS {
        let host = next
            .host_str()
            .ok_or_else(|| Error::Network("market image URL has no host".into()))?;
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, 443))
            .await
            .map_err(|cause| Error::Network(format!("market image DNS lookup failed: {cause}")))?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|address| blocked(address.ip())) {
            return Err(Error::Network(
                "market image resolved to a blocked local or special-use address".into(),
            ));
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(30))
            .resolve(host, addresses[0])
            .build()
            .map_err(|cause| Error::Network(format!("market image client failed: {cause}")))?;
        let mut response = client
            .get(next.clone())
            .header("accept", "image/png,image/jpeg,image/webp")
            .header("accept-encoding", "identity")
            .header("user-agent", "dsh-studio-market-media/1")
            .send()
            .await
            .map_err(|cause| Error::Network(format!("market image request failed: {cause}")))?;

        if response.status().is_redirection() {
            if redirects == MAX_REDIRECTS {
                return Err(Error::Network(
                    "market image redirected too many times".into(),
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| Error::Network("market image redirect has no location".into()))?;
            next = safe_url(
                next.join(location)
                    .map_err(|_| Error::Network("market image redirect is invalid".into()))?
                    .as_str(),
                &allowed,
            )?;
            continue;
        }
        if !response.status().is_success() {
            return Err(Error::Network(format!(
                "market image returned HTTP {}",
                response.status()
            )));
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|value| value.as_bytes() != b"identity")
        {
            return Err(Error::Network(
                "market image content encoding is not allowed".into(),
            ));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if !matches!(
            content_type.as_str(),
            "image/png" | "image/jpeg" | "image/webp"
        ) {
            return Err(Error::Network(
                "market image response is not a supported raster image".into(),
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|cause| Error::Network(format!("market image response failed: {cause}")))?
        {
            if body.len().saturating_add(chunk.len()) > MAX_BODY {
                return Err(Error::Network("market image exceeded 2 MiB".into()));
            }
            body.extend_from_slice(&chunk);
        }
        return normalize(&body);
    }
    unreachable!("redirect loop returns")
}

fn normalize(body: &[u8]) -> Result<Asset> {
    let image = image::load_from_memory(body)
        .map_err(|_| Error::Network("market image could not be decoded".into()))?;
    let (width, height) = (image.width(), image.height());
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(Error::Network(
            "market image dimensions are outside the safe limit".into(),
        ));
    }
    let image = image.thumbnail(OUTPUT_DIMENSION, OUTPUT_DIMENSION);
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|_| Error::Network("market image could not be normalized".into()))?;
    Ok(Asset {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.into_inner())
        ),
    })
}

fn normalized_hosts(values: &[String]) -> Result<Vec<String>> {
    let mut hosts = Vec::new();
    for value in values {
        let value = value.trim().to_ascii_lowercase();
        let parsed = url::Url::parse(&format!("https://{value}"))
            .map_err(|_| Error::Network("market image host is invalid".into()))?;
        if value.is_empty()
            || value.contains('*')
            || parsed.host_str() != Some(value.as_str())
            || parsed.port().is_some()
        {
            return Err(Error::Network("market image host is invalid".into()));
        }
        if !hosts.contains(&value) {
            hosts.push(value);
        }
    }
    if hosts.is_empty() {
        return Err(Error::Network("market image has no allowed host".into()));
    }
    Ok(hosts)
}

fn safe_url(value: &str, allowed: &[String]) -> Result<url::Url> {
    let url =
        url::Url::parse(value).map_err(|_| Error::Network("market image URL is invalid".into()))?;
    if value.len() > 2_048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|port| port != 443)
        || !url
            .host_str()
            .is_some_and(|host| allowed.iter().any(|allowed| allowed == host))
    {
        return Err(Error::Network(
            "market image URL is outside its allowed HTTPS hosts".into(),
        ));
    }
    Ok(url)
}

fn blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 198 && (18..=19).contains(&octets[1]))
                || octets[0] >= 224
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{blocked, normalize, normalized_hosts, safe_url};
    use image::{DynamicImage, ImageFormat, RgbaImage};
    use std::io::Cursor;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn image_urls_are_exact_https_hosts_without_credentials() {
        let hosts = normalized_hosts(&["cdn.example".into()]).unwrap();
        assert!(safe_url("https://cdn.example/icon.png", &hosts).is_ok());
        assert!(safe_url("https://user@cdn.example/icon.png", &hosts).is_err());
        assert!(safe_url("https://other.example/icon.png", &hosts).is_err());
        assert!(safe_url("http://cdn.example/icon.png", &hosts).is_err());
    }

    #[test]
    fn local_and_special_use_addresses_are_blocked() {
        assert!(blocked(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(blocked(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(blocked(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!blocked(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn decoded_pixels_are_reencoded_as_a_metadata_free_png() {
        let image =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255])));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::WebP).unwrap();
        let asset = normalize(&bytes.into_inner()).unwrap();
        assert!(asset.data_url.starts_with("data:image/png;base64,"));
    }
}

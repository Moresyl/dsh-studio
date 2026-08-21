//! Multiple plugin discovery sources behind one non-executable catalog model.
//!
//! Catalogs can suggest only an exact npm package and version. They cannot pass
//! shell commands, file paths, git URLs or lifecycle permissions to the host.
//! The chosen target is resolved again through the configured npm registry by
//! `registry::preflight` before the profile transaction begins.

use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::registry::Listing;
use crate::error::{Error, Result};

const STORE_ID: &str = "dsh-1024store";
const STORE_LABEL: &str = "DSH 1024Store";
const STORE_ENDPOINT: &str = "https://deepseek1024.com/api/v1/plugins";
const MAX_BODY: usize = 2 << 20;
const MAX_ITEMS: usize = 10_000;
const MAX_CUSTOM: usize = 12;
const MAX_REDIRECTS: usize = 3;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub endpoint: Option<String>,
    pub built_in: bool,
    pub active: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default = "default_active")]
    active: String,
    #[serde(default)]
    custom: Vec<Custom>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Custom {
    id: String,
    label: String,
    endpoint: String,
}

pub fn sources() -> Vec<Source> {
    let settings = load();
    let mut sources = vec![
        Source {
            id: "npm".to_string(),
            label: "npm registry".to_string(),
            kind: "npm".to_string(),
            endpoint: None,
            built_in: true,
            active: settings.active == "npm",
        },
        Source {
            id: STORE_ID.to_string(),
            label: STORE_LABEL.to_string(),
            kind: "reviewed-http".to_string(),
            endpoint: Some(STORE_ENDPOINT.to_string()),
            built_in: true,
            active: settings.active == STORE_ID,
        },
    ];
    sources.extend(settings.custom.into_iter().map(|custom| Source {
        active: settings.active == custom.id,
        id: custom.id,
        label: custom.label,
        kind: "standard-http-v1".to_string(),
        endpoint: Some(custom.endpoint),
        built_in: false,
    }));
    if !sources.iter().any(|source| source.active) {
        sources[0].active = true;
    }
    sources
}

pub fn select(id: &str) -> Result<Vec<Source>> {
    let roster = sources();
    if !roster.iter().any(|source| source.id == id) {
        return Err(Error::Plugin(format!("unknown catalog source {id}")));
    }
    let mut settings = load();
    settings.active = id.to_string();
    save(&settings)?;
    Ok(sources())
}

pub async fn add(label: &str, endpoint: &str) -> Result<Vec<Source>> {
    let label = plain(label, 64).ok_or_else(|| Error::Plugin("catalog label is invalid".into()))?;
    let endpoint = safe_url(endpoint)?;
    // Registration proves the endpoint answers the public contract before it
    // can become an active source.
    let value = restricted_json(endpoint.as_str()).await?;
    parse_standard(&value, "registration", &label, "").map(|_| ())?;

    let mut settings = load();
    if settings.custom.len() >= MAX_CUSTOM {
        return Err(Error::Plugin(format!(
            "at most {MAX_CUSTOM} custom catalog sources are allowed"
        )));
    }
    if settings
        .custom
        .iter()
        .any(|source| source.endpoint == endpoint.as_str())
    {
        return Err(Error::Plugin(
            "that catalog endpoint is already registered".into(),
        ));
    }
    let id = custom_id(endpoint.as_str());
    settings.custom.push(Custom {
        id: id.clone(),
        label,
        endpoint: endpoint.to_string(),
    });
    settings.active = id;
    save(&settings)?;
    Ok(sources())
}

pub fn remove(id: &str) -> Result<Vec<Source>> {
    let mut settings = load();
    let before = settings.custom.len();
    settings.custom.retain(|source| source.id != id);
    if settings.custom.len() == before {
        return Err(Error::Plugin(
            "built-in or unknown catalog sources cannot be removed".into(),
        ));
    }
    if settings.active == id {
        settings.active = default_active();
    }
    save(&settings)?;
    Ok(sources())
}

pub async fn search(source_id: &str, query: &str) -> Result<Vec<Listing>> {
    match source_id {
        STORE_ID => {
            let value = restricted_json(STORE_ENDPOINT).await?;
            parse_store(&value, query)
        }
        "npm" => Err(Error::Plugin(
            "npm discovery is handled by the configured registry".into(),
        )),
        custom => {
            let settings = load();
            let source = settings
                .custom
                .iter()
                .find(|source| source.id == custom)
                .ok_or_else(|| Error::Plugin(format!("unknown catalog source {custom}")))?;
            let value = restricted_json(&source.endpoint).await?;
            parse_standard(&value, &source.id, &source.label, query)
        }
    }
}

pub fn label(id: &str) -> String {
    sources()
        .into_iter()
        .find(|source| source.id == id)
        .map(|source| source.label)
        .unwrap_or_else(|| id.to_string())
}

async fn restricted_json(start: &str) -> Result<serde_json::Value> {
    crate::node::ensure_crypto_provider();
    let original = safe_url(start)?;
    let origin = original.origin().ascii_serialization();
    let mut next = original;

    for redirects in 0..=MAX_REDIRECTS {
        if next.origin().ascii_serialization() != origin {
            return Err(Error::Network(
                "catalog redirects may not change the registered origin".into(),
            ));
        }
        let host = next
            .host_str()
            .ok_or_else(|| Error::Network("catalog URL has no host".into()))?;
        let port = next.port_or_known_default().unwrap_or(443);
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|cause| Error::Network(format!("catalog DNS lookup failed: {cause}")))?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|address| blocked(address.ip())) {
            return Err(Error::Network(
                "catalog host resolved to a blocked local or special-use address".into(),
            ));
        }
        let pinned = addresses[0];
        let client = reqwest::Client::builder()
            // A proxy would resolve the hostname a second time and undo the
            // address we just admitted, reopening DNS rebinding around SSRF.
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(30))
            .resolve(host, pinned)
            .build()
            .map_err(|cause| Error::Network(format!("catalog client failed: {cause}")))?;
        let mut response = client
            .get(next.clone())
            .header("accept", "application/json")
            .header("accept-encoding", "identity")
            .header("user-agent", "dsh-studio-market/1")
            .send()
            .await
            .map_err(|cause| Error::Network(format!("catalog request failed: {cause}")))?;

        if response.status().is_redirection() {
            if redirects == MAX_REDIRECTS {
                return Err(Error::Network("catalog redirected too many times".into()));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| Error::Network("catalog redirect has no location".into()))?;
            next = next
                .join(location)
                .map_err(|_| Error::Network("catalog redirect is invalid".into()))?;
            continue;
        }
        if !response.status().is_success() {
            return Err(Error::Network(format!(
                "catalog returned HTTP {}",
                response.status()
            )));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !(content_type.starts_with("application/json") || content_type.contains("+json")) {
            return Err(Error::Network("catalog response is not JSON".into()));
        }

        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|cause| Error::Network(format!("catalog response failed: {cause}")))?
        {
            if body.len() + chunk.len() > MAX_BODY {
                return Err(Error::Network(format!(
                    "catalog response exceeded {} MiB",
                    MAX_BODY >> 20
                )));
            }
            body.extend_from_slice(&chunk);
        }
        return serde_json::from_slice(&body)
            .map_err(|cause| Error::Network(format!("catalog JSON is invalid: {cause}")));
    }
    unreachable!("redirect loop returns")
}

fn safe_url(value: &str) -> Result<url::Url> {
    let url =
        url::Url::parse(value).map_err(|_| Error::Network("catalog URL is invalid".into()))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err(Error::Network(
            "catalog URL must be credential-free HTTPS on port 443".into(),
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

fn parse_store(value: &serde_json::Value, query: &str) -> Result<Vec<Listing>> {
    let packages = value
        .get("packages")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| Error::Network("1024Store catalog has no packages array".into()))?;
    if packages.len() > MAX_ITEMS {
        return Err(Error::Network(
            "1024Store catalog exceeded the item limit".into(),
        ));
    }
    let query = query.trim().to_ascii_lowercase();
    let mut seen = BTreeSet::new();
    let mut listings = Vec::new();
    for package in packages {
        let Some(methods) = package
            .get("installMethods")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        let exact: Vec<(&str, &str)> = methods
            .iter()
            .filter_map(|method| {
                if method.get("kind")?.as_str()? != "npm"
                    || method.get("verification")?.as_str()? != "verified"
                    || method.get("code")?.as_str()? != "repository_backlink"
                    || method.get("requiresBuildAllowance")?.as_bool()?
                {
                    return None;
                }
                Some((
                    method.get("spec")?.as_str()?,
                    method.get("revision")?.as_str()?,
                ))
            })
            .collect();
        if exact.len() != 1 {
            continue;
        }
        let (name, version) = exact[0];
        if !super::is_package_spec(&format!("{name}@{version}")) || !seen.insert(name.to_string()) {
            continue;
        }
        let description = localized_description(package.get("description"));
        let publisher = text(package, "owner", 120).unwrap_or_default();
        let haystack = format!("{name} {description} {publisher}").to_ascii_lowercase();
        if !query.is_empty() && !haystack.contains(&query) {
            continue;
        }
        listings.push(Listing {
            name: name.to_string(),
            version: version.to_string(),
            description,
            publisher,
            updated: text(package, "updatedAt", 64)
                .or_else(|| text(package, "pushedAt", 64))
                .unwrap_or_default(),
            weekly_downloads: package
                .get("installs7d")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_default(),
            link: safe_github(package.get("url").and_then(serde_json::Value::as_str)),
            source_id: STORE_ID.to_string(),
            source_label: STORE_LABEL.to_string(),
            installable: true,
            categories: categories(package),
        });
    }
    Ok(listings)
}

fn parse_standard(
    value: &serde_json::Value,
    source_id: &str,
    source_label: &str,
    query: &str,
) -> Result<Vec<Listing>> {
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        != Some("1.0.0")
    {
        return Err(Error::Network(
            "standard catalog schemaVersion must be 1.0.0".into(),
        ));
    }
    let items = value
        .get("items")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| Error::Network("standard catalog has no items array".into()))?;
    if items.len() > MAX_ITEMS {
        return Err(Error::Network(
            "standard catalog exceeded the item limit".into(),
        ));
    }
    let query = query.trim().to_ascii_lowercase();
    let mut seen = BTreeSet::new();
    let mut listings = Vec::new();
    for item in items {
        let package = item.get("package");
        let Some(name) = package
            .and_then(|package| package.get("name"))
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Some(version) = item
            .get("latestVersion")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        if !super::is_package_spec(&format!("{name}@{version}")) || !seen.insert(name.to_string()) {
            continue;
        }
        let description = text(item, "summary", 1_000).unwrap_or_default();
        let publisher = item
            .pointer("/publisher/name")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| plain(value, 120))
            .unwrap_or_default();
        let haystack = format!("{name} {description} {publisher}").to_ascii_lowercase();
        if !query.is_empty() && !haystack.contains(&query) {
            continue;
        }
        listings.push(Listing {
            name: name.to_string(),
            version: version.to_string(),
            description,
            publisher,
            updated: text(item, "updatedAt", 64).unwrap_or_default(),
            weekly_downloads: 0,
            link: item
                .pointer("/repository/url")
                .and_then(serde_json::Value::as_str)
                .and_then(|value| safe_url(value).ok().map(|url| url.to_string())),
            source_id: source_id.to_string(),
            source_label: source_label.to_string(),
            installable: true,
            categories: categories(item),
        });
    }
    Ok(listings)
}

fn categories(value: &serde_json::Value) -> Vec<String> {
    let mut categories: Vec<String> = ["categories", "tags", "keywords"]
        .into_iter()
        .filter_map(|key| value.get(key))
        .flat_map(|value| match value {
            serde_json::Value::Array(values) => values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>(),
            serde_json::Value::String(value) => value.split(',').collect(),
            _ => Vec::new(),
        })
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 48)
        .take(20)
        .map(str::to_string)
        .collect();
    categories.sort_by_key(|value| value.to_ascii_lowercase());
    categories.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    categories
}

fn localized_description(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(value)) => plain(value, 5_000).unwrap_or_default(),
        Some(value) => value
            .get("zh")
            .or_else(|| value.get("en"))
            .and_then(serde_json::Value::as_str)
            .and_then(|value| plain(value, 5_000))
            .unwrap_or_default(),
        None => String::new(),
    }
}

fn text(value: &serde_json::Value, key: &str, max: usize) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .and_then(|value| plain(value, max))
}

fn plain(value: &str, max: usize) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()
        && trimmed.len() <= max
        && !trimmed.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        }))
    .then(|| trimmed.to_string())
}

fn safe_github(value: Option<&str>) -> Option<String> {
    let url = safe_url(value?).ok()?;
    (url.host_str()?.eq_ignore_ascii_case("github.com")).then(|| url.to_string())
}

fn custom_id(endpoint: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(endpoint.as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("custom-{suffix}")
}

fn load() -> Settings {
    let mut settings: Settings = std::fs::read(crate::paths::market_sources_file())
        .ok()
        .and_then(|body| serde_json::from_slice(&body).ok())
        .unwrap_or_else(|| Settings {
            active: default_active(),
            custom: Vec::new(),
        });
    settings.custom.truncate(MAX_CUSTOM);
    let mut seen_ids = BTreeSet::new();
    settings.custom.retain(|source| {
        source.id == custom_id(&source.endpoint)
            && plain(&source.label, 64).is_some()
            && safe_url(&source.endpoint).is_ok()
            && seen_ids.insert(source.id.clone())
    });
    let active_is_valid = settings.active == "npm"
        || settings.active == STORE_ID
        || settings
            .custom
            .iter()
            .any(|source| source.id == settings.active);
    if !active_is_valid {
        settings.active = default_active();
    }
    settings
}

fn save(settings: &Settings) -> Result<()> {
    if settings.custom.len() > MAX_CUSTOM {
        return Err(Error::Plugin("too many catalog sources".into()));
    }
    let path = crate::paths::market_sources_file();
    let parent = path
        .parent()
        .ok_or_else(|| Error::Plugin("catalog settings path has no parent".into()))?;
    std::fs::create_dir_all(parent)
        .map_err(|cause| Error::Plugin(format!("could not create catalog settings: {cause}")))?;
    let body = serde_json::to_vec_pretty(settings)
        .map_err(|cause| Error::Plugin(format!("could not encode catalog settings: {cause}")))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, body)
        .map_err(|cause| Error::Plugin(format!("could not write catalog settings: {cause}")))?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|cause| {
            Error::Plugin(format!("could not replace catalog settings: {cause}"))
        })?;
    }
    std::fs::rename(temporary, path)
        .map_err(|cause| Error::Plugin(format!("could not commit catalog settings: {cause}")))
}

fn default_active() -> String {
    "npm".to_string()
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use super::{blocked, parse_standard, parse_store, safe_url};

    #[test]
    fn catalog_network_rejects_credentials_ports_and_private_addresses() {
        assert!(safe_url("http://catalog.example/items").is_err());
        assert!(safe_url("https://user:pass@catalog.example/items").is_err());
        assert!(safe_url("https://catalog.example:8443/items").is_err());
        assert!(blocked(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(blocked(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 2))));
        assert!(blocked(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!blocked(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn standard_catalog_accepts_only_exact_npm_targets() {
        let value = serde_json::json!({ "schemaVersion": "1.0.0", "items": [
            { "package": { "name": "safe-plugin" }, "latestVersion": "1.2.3", "summary": "Safe" },
            { "package": { "name": "git+https://bad" }, "latestVersion": "main", "summary": "Bad" }
        ]});
        let items = parse_standard(&value, "custom-a", "A", "").expect("catalog");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "safe-plugin");
        assert_eq!(items[0].source_id, "custom-a");
    }

    #[test]
    fn standard_catalog_rejects_unknown_contract_versions() {
        let value = serde_json::json!({ "schemaVersion": "2.0.0", "items": [] });
        assert!(parse_standard(&value, "custom-a", "A", "").is_err());
    }

    #[test]
    fn reviewed_store_ignores_unverified_commands() {
        let value = serde_json::json!({ "packages": [
            { "name": "bad", "installMethods": [{ "kind": "github", "spec": "github:x/y" }] },
            { "owner": "a", "description": "good", "installMethods": [{
                "kind": "npm", "verification": "verified", "code": "repository_backlink",
                "requiresBuildAllowance": false, "spec": "good-plugin", "revision": "1.0.0"
            }] }
        ]});
        let items = parse_store(&value, "").expect("catalog");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "good-plugin");
    }

    #[tokio::test]
    #[ignore = "queries the live reviewed catalog"]
    async fn live_reviewed_store_keeps_installable_results() {
        let items = super::search(super::STORE_ID, "")
            .await
            .expect("live catalog");
        assert!(!items.is_empty());
        assert!(items.iter().all(|item| item.installable));
        assert!(items.iter().all(|item| item.source_id == super::STORE_ID));
    }
}

//! Multiple plugin discovery sources behind one non-executable catalog model.
//!
//! Catalogs can suggest only an exact npm package and version. They cannot pass
//! shell commands, file paths, git URLs or lifecycle permissions to the host.
//! The chosen target is resolved again through the configured npm registry by
//! `registry::preflight` before the profile transaction begins.

use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::registry::Listing;
use crate::error::{Error, Result};

const STORE_ID: &str = "dsh-1024store";
const STORE_LABEL: &str = "DSH 1024Store";
const STORE_ENDPOINT: &str = "https://deepseek1024.com/api/v1/plugins";
pub(crate) const DSHFIND_ID: &str = "dshfind";
const DSHFIND_LABEL: &str = "dshfind";
const DSHFIND_ENDPOINT: &str = "https://api.dshfind.com/v1/plugins";
const DSHFIND_PAGE_SIZE: usize = 100;
// dshfind documents this exact user agent as its bounded desktop view: at
// most 200 entries over two pages, with false plugins removed server-side.
const DSHFIND_MAX_ITEMS: usize = 200;
const DSHFIND_MAX_PAGES: usize = 2;
const DSHFIND_PAGE_DELAY: Duration = Duration::from_millis(2_100);
const DSHFIND_USER_AGENT: &str = "dsh-community-market/0.1";
const DEFAULT_USER_AGENT: &str = "dsh-studio-market/1";
const MAX_CUSTOM_BODY: usize = 2 << 20;
// The reviewed 1024Store snapshot is currently larger than 2 MiB. It remains
// a pinned built-in origin and still has a finite streaming budget.
const MAX_REVIEWED_BODY: usize = 8 << 20;
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

/// One fresh, read-only conformance probe for a discovery source.
///
/// The report deliberately contains no response body or package metadata. It
/// is safe to show in diagnostics without leaking a private registry token or
/// allowing a catalog to smuggle renderer-controlled markup into the app.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub source_id: String,
    pub contract: String,
    pub checked_at: u64,
    pub items: usize,
    pub installable: usize,
    pub latency_ms: u64,
    pub warnings: Vec<String>,
}

impl Health {
    pub(crate) fn from_listings(
        source_id: &str,
        contract: &str,
        listings: &[Listing],
        latency_ms: u64,
    ) -> Self {
        let installable = listings.iter().filter(|item| item.installable).count();
        let mut warnings = Vec::new();
        if listings.is_empty() {
            warnings.push("the source returned no catalog items".to_string());
        } else if installable == 0 {
            warnings.push("the source returned no installable exact npm versions".to_string());
        } else if installable < listings.len() {
            warnings.push(format!(
                "{} catalog items were excluded from installation",
                listings.len() - installable
            ));
        }
        Self {
            source_id: source_id.to_string(),
            contract: contract.to_string(),
            checked_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            items: listings.len(),
            installable,
            latency_ms,
            warnings,
        }
    }
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
        Source {
            id: DSHFIND_ID.to_string(),
            label: DSHFIND_LABEL.to_string(),
            kind: "reviewed-http".to_string(),
            endpoint: Some(DSHFIND_ENDPOINT.to_string()),
            built_in: true,
            active: settings.active == DSHFIND_ID,
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
    let value = restricted_json(endpoint.as_str(), MAX_CUSTOM_BODY, DEFAULT_USER_AGENT).await?;
    parse_standard(&value, "registration", &label, "", endpoint.as_str()).map(|_| ())?;

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
            let value =
                restricted_json(STORE_ENDPOINT, MAX_REVIEWED_BODY, DEFAULT_USER_AGENT).await?;
            parse_store(&value, query)
        }
        DSHFIND_ID => fetch_dshfind(query).await,
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
            let value =
                restricted_json(&source.endpoint, MAX_CUSTOM_BODY, DEFAULT_USER_AGENT).await?;
            parse_standard(&value, &source.id, &source.label, query, &source.endpoint)
        }
    }
}

/// Fetch and parse the complete bounded view used by a catalog source.
/// Successful completion proves the current response still satisfies the
/// source contract and all of the normal size, SSRF, identity and item limits.
pub async fn health(source_id: &str) -> Result<Health> {
    let contract = match source_id {
        STORE_ID => "reviewed-http/1024store",
        DSHFIND_ID => "reviewed-http/dshfind-v1",
        "npm" => {
            return Err(Error::Plugin(
                "npm registry health is checked through its package metadata authority".into(),
            ))
        }
        _ => "standard-http/1.0.0",
    };
    let started = std::time::Instant::now();
    let listings = search(source_id, "").await?;
    Ok(Health::from_listings(
        source_id,
        contract,
        &listings,
        started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
    ))
}

/// Re-read one catalog identity for detail, media and commit validation. The
/// dshfind search index does not promise to index npm package aliases, so an
/// exact-name miss falls back to its bounded 200-item desktop view.
pub async fn find(
    source_id: &str,
    name: &str,
    version: &str,
    repository: Option<&str>,
) -> Result<Option<Listing>> {
    if source_id == DSHFIND_ID {
        if let Some(endpoint) = repository.and_then(dshfind_detail_url) {
            let value =
                restricted_json(endpoint.as_str(), MAX_CUSTOM_BODY, DSHFIND_USER_AGENT).await?;
            return Ok(parse_dshfind_item(&value, "")
                .filter(|item| item.name == name && item.version == version));
        }
    }
    let matches = search(source_id, name).await?;
    if let Some(item) = exact_listing(matches, name, version) {
        return Ok(Some(item));
    }
    if source_id == DSHFIND_ID {
        return search(source_id, "")
            .await
            .map(|items| exact_listing(items, name, version));
    }
    Ok(None)
}

fn dshfind_detail_url(repository: &str) -> Option<url::Url> {
    let repository = safe_url(repository).ok()?;
    if !repository.host_str()?.eq_ignore_ascii_case("github.com") || repository.query().is_some() {
        return None;
    }
    let segments: Vec<_> = repository
        .path_segments()?
        .filter(|part| !part.is_empty())
        .collect();
    if segments.len() != 2 {
        return None;
    }
    let owner = segments[0];
    let name = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
    if !github_part(owner, 100, false) || !github_part(name, 100, true) {
        return None;
    }
    let mut endpoint = safe_url(DSHFIND_ENDPOINT).ok()?;
    endpoint
        .path_segments_mut()
        .ok()?
        .clear()
        .extend(["v1", "plugins", owner, name]);
    Some(endpoint)
}

fn exact_listing(items: Vec<Listing>, name: &str, version: &str) -> Option<Listing> {
    items
        .into_iter()
        .find(|item| item.name == name && item.version == version && item.installable)
}

async fn restricted_json(
    start: &str,
    max_body: usize,
    user_agent: &str,
) -> Result<serde_json::Value> {
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
        // A dual-stack resolver may return an unroutable local/special-use
        // address alongside the public address (this is common with split DNS
        // and enterprise VPNs). Rejecting the whole answer made the built-in
        // catalogs unusable on those machines. Keep the SSRF guard by selecting
        // and pinning one admissible public address; a host that resolves only
        // to blocked addresses is still refused.
        let pinned = admissible_address(&addresses).ok_or_else(|| {
            Error::Network("catalog host resolved to a blocked local or special-use address".into())
        })?;
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
            .header("user-agent", user_agent)
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
        if response
            .content_length()
            .is_some_and(|content_length| content_length > max_body as u64)
        {
            return Err(Error::Network(format!(
                "catalog response exceeded {} MiB",
                max_body >> 20
            )));
        }

        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|cause| Error::Network(format!("catalog response failed: {cause}")))?
        {
            if body.len().saturating_add(chunk.len()) > max_body {
                return Err(Error::Network(format!(
                    "catalog response exceeded {} MiB",
                    max_body >> 20
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
                || (octets[0] == 192 && octets[1] == 0 && (octets[2] == 0 || octets[2] == 2))
                || (octets[0] == 198 && (18..=19).contains(&octets[1]))
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                || octets[0] >= 224
        }
        IpAddr::V6(ip) => {
            ip.to_ipv4_mapped()
                .is_some_and(|mapped| blocked(IpAddr::V4(mapped)))
                || ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
                || (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
        }
    }
}

fn admissible_address(addresses: &[SocketAddr]) -> Option<SocketAddr> {
    addresses
        .iter()
        .copied()
        .find(|address| !blocked(address.ip()))
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
        if !super::is_package_name(name)
            || !exact_market_version(version)
            || !seen.insert(name.to_string())
        {
            continue;
        }
        let description = localized_description(package.get("description"));
        let publisher = text(package, "owner", 120).unwrap_or_default();
        let haystack = format!("{name} {description} {publisher}").to_ascii_lowercase();
        if !query.is_empty() && !haystack.contains(&query) {
            continue;
        }
        let repository = safe_github(package.get("url").and_then(serde_json::Value::as_str));
        let icon = store_icon(package, repository.as_deref());
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
            link: repository.clone(),
            repository,
            source_id: STORE_ID.to_string(),
            source_label: STORE_LABEL.to_string(),
            installable: true,
            categories: categories(package),
            has_icon: icon.is_some(),
            icon,
        });
    }
    Ok(listings)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DshfindDataset {
    total: usize,
    total_pages: usize,
    data_version: String,
    as_of: String,
}

#[derive(Debug)]
struct DshfindPage {
    data: Vec<serde_json::Value>,
    dataset: DshfindDataset,
}

/// Fetch one immutable dshfind dataset without exceeding its anonymous
/// 30-request/minute contract. Every later page is pinned to page one's
/// `data_version`, so a catalog refresh cannot splice two generations together.
async fn fetch_dshfind(query: &str) -> Result<Vec<Listing>> {
    let mut page_number = 1usize;
    let mut dataset: Option<DshfindDataset> = None;
    let mut ids = BTreeSet::new();
    let mut packages = BTreeSet::new();
    let mut listings = Vec::new();

    loop {
        let endpoint = dshfind_page_url(
            page_number,
            dataset.as_ref().map(|item| item.data_version.as_str()),
            query,
        )?;
        let page = parse_dshfind_page(
            &restricted_json(endpoint.as_str(), MAX_CUSTOM_BODY, DSHFIND_USER_AGENT).await?,
            page_number,
        )?;
        if let Some(expected) = &dataset {
            if expected != &page.dataset {
                return Err(Error::Network(
                    "dshfind dataset changed during pagination".into(),
                ));
            }
        } else {
            dataset = Some(page.dataset.clone());
        }

        for item in page.data {
            if let Some(id) = text(&item, "full_name", 160) {
                if !ids.insert(id.to_ascii_lowercase()) {
                    return Err(Error::Network(
                        "dshfind catalog contains duplicate item IDs".into(),
                    ));
                }
            }
            let Some(listing) = parse_dshfind_item(&item, query) else {
                continue;
            };
            if packages.insert(listing.name.clone()) {
                listings.push(listing);
            }
        }

        let total_pages = dataset.as_ref().map_or(0, |item| item.total_pages);
        if total_pages == 0 || page_number >= total_pages {
            break;
        }
        if page_number >= DSHFIND_MAX_PAGES {
            return Err(Error::Network(
                "dshfind catalog exceeded the page limit".into(),
            ));
        }
        tokio::time::sleep(DSHFIND_PAGE_DELAY).await;
        page_number += 1;
    }
    Ok(listings)
}

fn dshfind_page_url(page: usize, data_version: Option<&str>, search: &str) -> Result<url::Url> {
    let mut endpoint = safe_url(DSHFIND_ENDPOINT)?;
    {
        let mut query = endpoint.query_pairs_mut();
        query.append_pair("page", &page.to_string());
        query.append_pair("per_page", &DSHFIND_PAGE_SIZE.to_string());
        let search: String = search.trim().chars().take(64).collect();
        if !search.is_empty() {
            query.append_pair("q", &search);
        }
        if let Some(data_version) = data_version {
            query.append_pair("data_version", data_version);
        }
    }
    Ok(endpoint)
}

fn parse_dshfind_page(value: &serde_json::Value, expected_page: usize) -> Result<DshfindPage> {
    let data = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| Error::Network("dshfind response has no data array".into()))?;
    let page = dshfind_usize(value, "page")?;
    let per_page = dshfind_usize(value, "per_page")?;
    let total = dshfind_usize(value, "total")?;
    let total_pages = dshfind_usize(value, "total_pages")?;
    if page != expected_page {
        return Err(Error::Network(
            "dshfind response page did not match the request".into(),
        ));
    }
    if per_page != DSHFIND_PAGE_SIZE {
        return Err(Error::Network(
            "dshfind response changed the requested page size".into(),
        ));
    }
    if total > DSHFIND_MAX_ITEMS || total_pages > DSHFIND_MAX_PAGES {
        return Err(Error::Network(
            "dshfind catalog exceeded the item or page limit".into(),
        ));
    }
    let calculated_pages = total.div_ceil(DSHFIND_PAGE_SIZE);
    if total_pages != calculated_pages || (total_pages > 0 && page > total_pages) {
        return Err(Error::Network(
            "dshfind response page metadata is inconsistent".into(),
        ));
    }
    let expected_items = if total_pages == 0 {
        0
    } else if page < total_pages {
        DSHFIND_PAGE_SIZE
    } else {
        total - (page - 1) * DSHFIND_PAGE_SIZE
    };
    if data.len() != expected_items || data.len() > DSHFIND_PAGE_SIZE {
        return Err(Error::Network(
            "dshfind response item count did not match page metadata".into(),
        ));
    }
    let data_version = text(value, "data_version", 71)
        .filter(|version| {
            version.strip_prefix("sha256:").is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
        })
        .ok_or_else(|| Error::Network("dshfind data_version is invalid".into()))?;
    let as_of = text(value, "as_of", 64)
        .filter(|date| date.contains('T') && date.ends_with('Z'))
        .ok_or_else(|| Error::Network("dshfind as_of is invalid".into()))?;

    Ok(DshfindPage {
        data: data.clone(),
        dataset: DshfindDataset {
            total,
            total_pages,
            data_version,
            as_of,
        },
    })
}

fn dshfind_usize(value: &serde_json::Value, key: &str) -> Result<usize> {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .and_then(|number| usize::try_from(number).ok())
        .ok_or_else(|| Error::Network(format!("dshfind {key} is invalid")))
}

fn parse_dshfind_item(value: &serde_json::Value, query: &str) -> Option<Listing> {
    if value.get("is_risky").and_then(serde_json::Value::as_bool) == Some(true) {
        return None;
    }
    let (repository, owner) = dshfind_repository(value)?;
    let (name, version) = dshfind_npm_target(value)?;
    let display_name = text(value, "name", 120).unwrap_or_else(|| name.clone());
    let description = text(value, "description", 5_000).unwrap_or_else(|| display_name.clone());
    let publisher = text(value, "owner", 120)
        .filter(|candidate| candidate.eq_ignore_ascii_case(&owner))
        .unwrap_or(owner);
    let needle = query.trim().to_ascii_lowercase();
    if !needle.is_empty()
        && !format!("{name} {display_name} {description} {publisher}")
            .to_ascii_lowercase()
            .contains(&needle)
    {
        return None;
    }
    let mut item_categories = categories(value);
    if let Some(category) = text(value, "category", 48) {
        item_categories.push(category);
        item_categories.sort_by_key(|item| item.to_ascii_lowercase());
        item_categories.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        item_categories.truncate(20);
    }
    let icon = store_icon(value, Some(&repository));
    Some(Listing {
        name,
        version,
        description,
        publisher,
        updated: text(value, "pushed_at", 64).unwrap_or_default(),
        weekly_downloads: 0,
        link: Some(repository.clone()),
        repository: Some(repository),
        source_id: DSHFIND_ID.to_string(),
        source_label: DSHFIND_LABEL.to_string(),
        installable: true,
        categories: item_categories,
        has_icon: icon.is_some(),
        icon,
    })
}

fn dshfind_repository(value: &serde_json::Value) -> Option<(String, String)> {
    let raw = value.get("repository_url")?.as_str()?;
    let url = safe_url(raw).ok()?;
    if !url.host_str()?.eq_ignore_ascii_case("github.com") || url.query().is_some() {
        return None;
    }
    let segments: Vec<_> = url
        .path_segments()?
        .filter(|part| !part.is_empty())
        .collect();
    if segments.len() != 2 {
        return None;
    }
    let owner = segments[0];
    let repository = segments[1].strip_suffix(".git").unwrap_or(segments[1]);
    if !github_part(owner, 100, false) || !github_part(repository, 100, true) {
        return None;
    }
    let full_name = text(value, "full_name", 160)?;
    if !full_name.eq_ignore_ascii_case(&format!("{owner}/{repository}")) {
        return None;
    }
    Some((
        format!("https://github.com/{owner}/{repository}"),
        owner.to_string(),
    ))
}

fn github_part(value: &str, max: usize, dot: bool) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || (dot && byte == b'.')
        })
}

fn dshfind_npm_target(value: &serde_json::Value) -> Option<(String, String)> {
    let install = value.get("install")?;
    let declared = install.get("pkg_name").and_then(serde_json::Value::as_str);
    let methods = install.get("methods")?.as_array()?;
    let mut targets = BTreeSet::new();
    for method in methods {
        if method.get("kind").and_then(serde_json::Value::as_str) != Some("npm")
            || method
                .get("verification")
                .and_then(serde_json::Value::as_str)
                != Some("verified")
            || method.get("code").and_then(serde_json::Value::as_str) != Some("repository_backlink")
            || method
                .get("requiresBuildAllowance")
                .and_then(serde_json::Value::as_bool)
                != Some(false)
        {
            continue;
        }
        let Some(name) = method.get("spec").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(raw_version) = method.get("revision").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if !super::is_package_name(name)
            || !exact_market_version(raw_version)
            || declared.is_some_and(|candidate| candidate != name)
        {
            continue;
        }
        targets.insert((name.to_string(), raw_version.to_string()));
    }
    (targets.len() == 1)
        .then(|| targets.into_iter().next())
        .flatten()
}

fn parse_standard(
    value: &serde_json::Value,
    source_id: &str,
    source_label: &str,
    query: &str,
    endpoint: &str,
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
        if !super::is_package_name(name)
            || !exact_market_version(version)
            || !seen.insert(name.to_string())
        {
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
        let repository = item
            .pointer("/repository/url")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| safe_url(value).ok().map(|url| url.to_string()));
        let icon = standard_icon(item, endpoint);
        listings.push(Listing {
            name: name.to_string(),
            version: version.to_string(),
            description,
            publisher,
            updated: text(item, "updatedAt", 64).unwrap_or_default(),
            weekly_downloads: 0,
            link: repository.clone(),
            repository,
            source_id: source_id.to_string(),
            source_label: source_label.to_string(),
            installable: true,
            categories: categories(item),
            has_icon: icon.is_some(),
            icon,
        });
    }
    Ok(listings)
}

/// Catalogs pin immutable npm versions. A prerelease such as `1.2.3-rc.1` is
/// still exact; ranges, tags and build metadata are not accepted identities.
fn exact_market_version(raw: &str) -> bool {
    semver::Version::parse(raw).is_ok_and(|version| version.build.is_empty())
}

fn standard_icon(item: &serde_json::Value, endpoint: &str) -> Option<super::media::Candidate> {
    let raw = item.pointer("/media/icon/url")?.as_str()?;
    let source = safe_url(endpoint).ok()?;
    let icon = safe_url(raw).ok()?;
    if icon.origin().ascii_serialization() != source.origin().ascii_serialization() {
        return None;
    }
    Some(super::media::Candidate {
        url: icon.to_string(),
        allowed_hosts: vec![icon.host_str()?.to_ascii_lowercase()],
    })
}

fn store_icon(
    package: &serde_json::Value,
    repository: Option<&str>,
) -> Option<super::media::Candidate> {
    if let Some(raw) = package
        .pointer("/media/icon/url")
        .and_then(serde_json::Value::as_str)
    {
        let icon = safe_url(raw).ok()?;
        let host = icon.host_str()?.to_ascii_lowercase();
        if matches!(
            host.as_str(),
            "deepseek1024.com" | "github.com" | "avatars.githubusercontent.com"
        ) {
            let allowed_hosts = if host == "github.com" {
                vec!["github.com".into(), "avatars.githubusercontent.com".into()]
            } else {
                vec![host]
            };
            return Some(super::media::Candidate {
                url: icon.to_string(),
                allowed_hosts,
            });
        }
    }
    let repository = safe_url(repository?).ok()?;
    if repository.host_str()? != "github.com" {
        return None;
    }
    let owner = repository
        .path_segments()?
        .find(|segment| !segment.is_empty())?;
    if owner.is_empty()
        || owner.len() > 39
        || !owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    Some(super::media::Candidate {
        url: format!("https://github.com/{owner}.png?size=96"),
        allowed_hosts: vec!["github.com".into(), "avatars.githubusercontent.com".into()],
    })
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
        || settings.active == DSHFIND_ID
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
    crate::atomic::write(&path, body)
        .map_err(|cause| Error::Plugin(format!("could not commit catalog settings: {cause}")))
}

fn default_active() -> String {
    "npm".to_string()
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    use super::{
        admissible_address, blocked, dshfind_detail_url, dshfind_page_url, exact_listing,
        parse_dshfind_item, parse_dshfind_page, parse_standard, parse_store, safe_url, Health,
    };

    #[test]
    fn catalog_network_rejects_credentials_ports_and_private_addresses() {
        assert!(safe_url("http://catalog.example/items").is_err());
        assert!(safe_url("https://user:pass@catalog.example/items").is_err());
        assert!(safe_url("https://catalog.example:8443/items").is_err());
        assert!(blocked(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(blocked(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 2))));
        assert!(blocked(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(blocked(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 12))));
        assert!(blocked(IpAddr::V6("2001:db8::1".parse().unwrap())));
        assert!(blocked(IpAddr::V6("::ffff:127.0.0.1".parse().unwrap())));
        assert!(!blocked(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        let mixed = [
            SocketAddr::from(([192, 168, 1, 20], 443)),
            SocketAddr::from(([8, 8, 8, 8], 443)),
        ];
        assert_eq!(admissible_address(&mixed), Some(mixed[1]));
        assert!(admissible_address(&mixed[..1]).is_none());
    }

    #[test]
    fn standard_catalog_accepts_only_exact_npm_targets() {
        let value = serde_json::json!({ "schemaVersion": "1.0.0", "items": [
            { "package": { "name": "safe-plugin" }, "latestVersion": "1.2.3", "summary": "Safe",
              "media": { "icon": { "url": "https://catalog.example/assets/safe.png" } } },
            { "package": { "name": "preview-plugin" }, "latestVersion": "1.2.3-rc.1" },
            { "package": { "name": "range-plugin" }, "latestVersion": "^1.2.3" },
            { "package": { "name": "git+https://bad" }, "latestVersion": "main", "summary": "Bad" }
        ]});
        let items = parse_standard(
            &value,
            "custom-a",
            "A",
            "",
            "https://catalog.example/plugins.json",
        )
        .expect("catalog");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "safe-plugin");
        assert_eq!(items[1].version, "1.2.3-rc.1");
        assert_eq!(items[0].source_id, "custom-a");
        assert!(items[0].has_icon);
        assert_eq!(
            items[0].icon.as_ref().map(|icon| icon.url.as_str()),
            Some("https://catalog.example/assets/safe.png")
        );
    }

    #[test]
    fn health_summary_counts_installable_items_and_reports_empty_sources() {
        let value = serde_json::json!({ "schemaVersion": "1.0.0", "items": [{
            "package": { "name": "safe-plugin" }, "latestVersion": "1.2.3"
        }]});
        let items = parse_standard(
            &value,
            "custom-a",
            "A",
            "",
            "https://catalog.example/plugins.json",
        )
        .expect("catalog");
        let report = Health::from_listings("custom-a", "standard-http/1.0.0", &items, 42);
        assert_eq!(report.items, 1);
        assert_eq!(report.installable, 1);
        assert_eq!(report.latency_ms, 42);
        assert!(report.warnings.is_empty());

        let empty = Health::from_listings("custom-b", "standard-http/1.0.0", &[], 1);
        assert_eq!(empty.installable, 0);
        assert_eq!(empty.warnings, ["the source returned no catalog items"]);
    }

    #[test]
    fn standard_catalog_omits_cross_origin_media_without_losing_the_item() {
        let value = serde_json::json!({ "schemaVersion": "1.0.0", "items": [{
            "package": { "name": "safe-plugin" },
            "latestVersion": "1.2.3",
            "media": { "icon": { "url": "https://tracker.example/pixel.png" } }
        }]});
        let items = parse_standard(
            &value,
            "custom-a",
            "A",
            "",
            "https://catalog.example/plugins.json",
        )
        .expect("catalog");
        assert_eq!(items.len(), 1);
        assert!(!items[0].has_icon);
        assert!(items[0].icon.is_none());
    }

    #[test]
    fn standard_catalog_rejects_unknown_contract_versions() {
        let value = serde_json::json!({ "schemaVersion": "2.0.0", "items": [] });
        assert!(parse_standard(
            &value,
            "custom-a",
            "A",
            "",
            "https://catalog.example/plugins.json"
        )
        .is_err());
    }

    #[test]
    fn exact_catalog_lookup_never_substitutes_a_different_version() {
        let listing = parse_dshfind_item(&dshfind_item(), "").expect("listing");
        assert!(exact_listing(vec![listing.clone()], &listing.name, "9.9.9").is_none());
        assert_eq!(
            exact_listing(vec![listing.clone()], &listing.name, &listing.version)
                .expect("same identity")
                .name,
            listing.name
        );
    }

    #[test]
    fn dshfind_detail_identity_is_derived_only_from_a_canonical_github_repository() {
        assert_eq!(
            dshfind_detail_url("https://github.com/Example/safe-plugin.git")
                .expect("detail URL")
                .as_str(),
            "https://api.dshfind.com/v1/plugins/Example/safe-plugin"
        );
        assert!(dshfind_detail_url("https://gitlab.com/example/safe-plugin").is_none());
        assert!(dshfind_detail_url("https://github.com/example/safe-plugin/issues").is_none());
        assert!(dshfind_detail_url("https://github.com/example/safe-plugin?token=x").is_none());
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

    fn dshfind_item() -> serde_json::Value {
        serde_json::json!({
            "full_name": "example/safe-plugin",
            "name": "safe-plugin",
            "owner": "example",
            "repository_url": "https://github.com/example/safe-plugin",
            "description": "A reviewed plugin",
            "tags": ["agent", "tools"],
            "category": "agent",
            "pushed_at": "2026-08-21T00:00:00Z",
            "is_risky": false,
            "install": {
                "pkg_name": "@example/safe-plugin",
                "methods": [{
                    "kind": "npm",
                    "verification": "verified",
                    "code": "repository_backlink",
                    "requiresBuildAllowance": false,
                    "spec": "@example/safe-plugin",
                    "revision": "1.2.3"
                }]
            }
        })
    }

    #[test]
    fn dshfind_accepts_one_exact_reviewed_npm_target_with_a_matching_repository() {
        let item = parse_dshfind_item(&dshfind_item(), "safe").expect("reviewed item");
        assert_eq!(item.name, "@example/safe-plugin");
        assert_eq!(item.version, "1.2.3");
        assert_eq!(item.source_id, super::DSHFIND_ID);
        assert_eq!(
            item.repository.as_deref(),
            Some("https://github.com/example/safe-plugin")
        );
        assert!(item.categories.contains(&"agent".to_string()));

        let mut risky = dshfind_item();
        risky["is_risky"] = serde_json::json!(true);
        assert!(parse_dshfind_item(&risky, "").is_none());

        let mut prerelease = dshfind_item();
        prerelease["install"]["methods"][0]["revision"] = serde_json::json!("1.2.3-rc.1");
        assert_eq!(
            parse_dshfind_item(&prerelease, "")
                .expect("exact prerelease")
                .version,
            "1.2.3-rc.1"
        );

        let mut range = dshfind_item();
        range["install"]["methods"][0]["revision"] = serde_json::json!("^1.2.3");
        assert!(parse_dshfind_item(&range, "").is_none());

        let mut mismatched = dshfind_item();
        mismatched["full_name"] = serde_json::json!("someone/else");
        assert!(parse_dshfind_item(&mismatched, "").is_none());
    }

    #[test]
    fn dshfind_pages_are_bounded_and_pinned_to_a_dataset_identity() {
        let hash = "a".repeat(64);
        let value = serde_json::json!({
            "data": [dshfind_item()],
            "page": 1,
            "per_page": 100,
            "total": 1,
            "total_pages": 1,
            "data_version": format!("sha256:{hash}"),
            "as_of": "2026-08-21T00:00:00Z"
        });
        let page = parse_dshfind_page(&value, 1).expect("page");
        assert_eq!(page.data.len(), 1);
        assert_eq!(page.dataset.total_pages, 1);

        let mut inconsistent = value.clone();
        inconsistent["total_pages"] = serde_json::json!(2);
        assert!(parse_dshfind_page(&inconsistent, 1).is_err());

        let url = dshfind_page_url(2, Some(&format!("sha256:{hash}")), " memory ").expect("URL");
        assert!(url.as_str().contains("page=2"));
        assert!(url.as_str().contains("data_version=sha256%3A"));
        assert!(url.as_str().contains("q=memory"));

        let mut oversized = value;
        oversized["total"] = serde_json::json!(201);
        oversized["total_pages"] = serde_json::json!(3);
        assert!(parse_dshfind_page(&oversized, 1).is_err());
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

    #[tokio::test]
    #[ignore = "scans the live rate-limited reviewed catalog"]
    async fn live_dshfind_scan_keeps_only_installable_results() {
        let items = super::search(super::DSHFIND_ID, "")
            .await
            .expect("live catalog");
        assert!(!items.is_empty());
        assert!(items.iter().all(|item| item.installable));
        assert!(items.iter().all(|item| item.source_id == super::DSHFIND_ID));
        let item = items.into_iter().next().expect("one installable item");
        let detail = super::find(
            super::DSHFIND_ID,
            &item.name,
            &item.version,
            item.repository.as_deref(),
        )
        .await
        .expect("live detail")
        .expect("same exact catalog identity");
        assert_eq!(detail.name, item.name);
        assert_eq!(detail.version, item.version);
    }
}

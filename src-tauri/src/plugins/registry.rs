//! What the ecosystem has published, read through the user's own registry.
//!
//! Which registry that is matters more than it looks. A large share of the
//! people this shell is for reach npm through a mirror, and a marketplace that
//! hard-coded the public registry would show them packages they then could not
//! install. So the address comes from npm's own resolved configuration —
//! asked once, because it cannot change while the app is running without npm
//! being reconfigured underneath it.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::error::{Error, Result};
use crate::fetch;
use crate::harness::install;

/// Where npm points when it has nothing to say.
const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";

/// What an empty search box asks for. Not a curated list: a list this project
/// maintained would be one more thing to keep honest, and would quietly decide
/// whose plugin is worth seeing.
const DISCOVERY: &str = "dsh bundle";

/// Enough to browse, few enough that the panel stays a panel.
const INDEX_RESULTS: &str = "250";

/// Generous, because this may be a mirror on a slow link.
const BUDGET: Duration = Duration::from_secs(20);

static REGISTRY: OnceCell<String> = OnceCell::const_new();

/// The one registry both review and installation must use. Keeping this value
/// shared prevents a profile-local npm setting from making pnpm install a
/// different package graph from the one the market just verified.
pub(super) async fn configured_base(node: &Path) -> String {
    base(node).await
}

/// One search result.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub name: String,
    pub version: String,
    pub description: String,
    pub publisher: String,
    /// ISO timestamp of the last publish, formatted by the panel.
    pub updated: String,
    pub weekly_downloads: u64,
    /// Somewhere to read more, if the package said where.
    pub link: Option<String>,
    /// Source repository asserted by the catalog, separate from a homepage.
    pub repository: Option<String>,
    pub source_id: String,
    pub source_label: String,
    pub installable: bool,
    #[serde(default)]
    pub categories: Vec<String>,
    pub has_icon: bool,
    #[serde(skip)]
    pub(crate) icon: Option<super::media::Candidate>,
}

/// What the published manifest says about one package.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub name: String,
    pub version: String,
    pub description: String,
    pub license: String,
    pub homepage: Option<String>,
    pub repository: Option<String>,
    /// Whether the manifest declares a profile patch. This is the difference
    /// between a plugin and a package that merely mentions the harness, and it
    /// is worth checking before installing rather than after.
    pub bundle: bool,
    pub dependencies: Vec<String>,
    /// Exact immutable spec the confirmation button will install.
    pub install_spec: String,
    /// Registry provenance shown before installation.
    pub source: String,
    pub compatibility: Compatibility,
    /// Registry integrity for the exact tarball, retained in market receipts.
    pub integrity: Option<String>,
    /// The profile patch itself, retained as provenance without executing it.
    pub bundle_patch: Option<serde_json::Value>,
    /// Package-manager lifecycle hooks that would run local code during install.
    pub lifecycle_scripts: Vec<String>,
    /// Presence is a hard market block, even when the registry supplied no text.
    pub deprecated: Option<String>,
    /// Set by the catalog command after comparing npm metadata with its source.
    pub repository_verified: bool,
    /// True only for a complete SHA-512 Subresource Integrity value.
    pub integrity_verified: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Compatibility {
    Compatible { requirement: String },
    Unknown,
    Incompatible { requirement: String, reason: String },
}

/// Search the registry, or show what a plugin looks like when asked nothing.
pub async fn search(node: &Path, query: &str) -> Result<Vec<Listing>> {
    let text = match query.trim() {
        "" => DISCOVERY,
        typed => typed,
    };

    let base = base(node).await;
    let mut endpoint = url::Url::parse(&format!("{base}/-/v1/search"))
        .map_err(|_| Error::Network(format!("{base} is not a usable registry address")))?;
    endpoint
        .query_pairs_mut()
        .append_pair("text", text)
        .append_pair("size", INDEX_RESULTS);

    let body = fetch::json(node, endpoint.as_str(), BUDGET).await?;
    Ok(body
        .get("objects")
        .and_then(serde_json::Value::as_array)
        .map(|objects| objects.iter().filter_map(listing).collect())
        .unwrap_or_default())
}

/// Read one package's latest published manifest.
pub async fn detail(node: &Path, name: &str) -> Result<Detail> {
    detail_with_source(node, name, "npm registry").await
}

pub async fn detail_with_source(node: &Path, name: &str, source: &str) -> Result<Detail> {
    if !super::is_package_name(name) {
        return Err(Error::Plugin(format!("{name} is not a package name")));
    }

    let base = base(node).await;
    let endpoint = format!("{base}/{name}/latest");
    let manifest = fetch::json(node, &endpoint, BUDGET).await?;

    Ok(detail_from_manifest(name, source, &manifest))
}

/// Resolve and validate the exact package spec immediately before mutation.
pub async fn preflight(node: &Path, spec: &str) -> Result<Detail> {
    let requested = exact_requested_version(spec)?;
    let detail = resolve(node, spec).await?;
    if detail.version != requested {
        return Err(Error::Plugin(
            "the registry did not resolve the requested exact package version".into(),
        ));
    }
    validate_preflight(&detail)?;
    Ok(detail)
}

fn exact_requested_version(spec: &str) -> Result<&str> {
    let (_, requested) = super::split_spec(spec);
    requested
        .filter(|version| {
            semver::Version::parse(version).is_ok_and(|parsed| parsed.build.is_empty())
        })
        .ok_or_else(|| Error::Plugin("market installs require an exact package version".into()))
}

/// Resolve an exact candidate for a review UI without weakening execution:
/// [`preflight`] repeats the same fetch and applies every hard block again.
pub async fn resolve(node: &Path, spec: &str) -> Result<Detail> {
    if !super::is_package_spec(spec) {
        return Err(Error::Plugin(format!("{spec} is not a package specifier")));
    }
    let (name, requested) = super::split_spec(spec);
    let version = requested.unwrap_or("latest");
    let base = base(node).await;
    let endpoint = format!("{base}/{name}/{version}");
    let manifest = fetch::json(node, &endpoint, BUDGET)
        .await
        .map_err(|failure| {
            Error::Plugin(format!(
                "preflight could not resolve {spec} from {base}: {failure}"
            ))
        })?;
    let detail = detail_from_manifest(name, &base, &manifest);
    if detail.version.is_empty() {
        return Err(Error::Plugin(format!(
            "preflight resolved {spec} but the registry returned no version"
        )));
    }
    Ok(detail)
}

fn validate_preflight(detail: &Detail) -> Result<()> {
    let version = semver::Version::parse(&detail.version).map_err(|_| {
        Error::Plugin("the registry did not return an exact semantic version".into())
    })?;
    if !version.build.is_empty() {
        return Err(Error::Plugin(
            "market installs require an exact package version without build metadata".into(),
        ));
    }
    if let Compatibility::Incompatible { reason, .. } = &detail.compatibility {
        return Err(Error::Plugin(format!(
            "{} is not compatible with Harness {}: {reason}",
            detail.name,
            crate::harness::install::VERSION
        )));
    }
    if detail.deprecated.is_some() {
        return Err(Error::Plugin(
            "deprecated packages cannot be installed from the market".into(),
        ));
    }
    if !detail.lifecycle_scripts.is_empty() {
        return Err(Error::Plugin(format!(
            "plugin packages with install lifecycle scripts are blocked: {}",
            detail.lifecycle_scripts.join(", ")
        )));
    }
    if !detail.integrity_verified {
        return Err(Error::Plugin(
            "the exact package has no verifiable SHA-512 registry integrity".into(),
        ));
    }
    Ok(())
}

fn detail_from_manifest(name: &str, source: &str, manifest: &serde_json::Value) -> Detail {
    let version = string(manifest, "version").unwrap_or_default();
    let integrity = manifest
        .pointer("/dist/integrity")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            manifest
                .pointer("/dist/shasum")
                .and_then(serde_json::Value::as_str)
                .map(|value| format!("sha1hex-{value}"))
        });
    let lifecycle_scripts = ["preinstall", "install", "postinstall", "prepare"]
        .into_iter()
        .filter(|name| manifest.pointer(&format!("/scripts/{name}")).is_some())
        .map(str::to_string)
        .collect();
    let deprecated = manifest.get("deprecated").map(|value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("deprecated by its publisher")
            .chars()
            .take(500)
            .collect()
    });
    let integrity_verified = integrity.as_deref().is_some_and(valid_sha512_integrity);
    Detail {
        name: string(manifest, "name").unwrap_or_else(|| name.to_string()),
        install_spec: format!("{name}@{version}"),
        version,
        description: string(manifest, "description").unwrap_or_default(),
        license: string(manifest, "license").unwrap_or_default(),
        homepage: string(manifest, "homepage"),
        repository: manifest
            .pointer("/repository/url")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        bundle: manifest.pointer("/dsh/bundle/patch").is_some(),
        dependencies: manifest
            .get("dependencies")
            .and_then(serde_json::Value::as_object)
            .map(|dependencies| dependencies.keys().cloned().collect())
            .unwrap_or_default(),
        source: source.to_string(),
        compatibility: compatibility(manifest),
        integrity,
        bundle_patch: manifest.pointer("/dsh/bundle/patch").cloned(),
        lifecycle_scripts,
        deprecated,
        repository_verified: false,
        integrity_verified,
    }
}

fn valid_sha512_integrity(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("sha512-") else {
        return false;
    };
    encoded.len() == 88
        && encoded.ends_with("==")
        && encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

/// Canonical HTTPS repository identity used for catalog backlink checks.
pub(crate) fn repository_identity(value: &str) -> Option<String> {
    let value = value.strip_prefix("git+").unwrap_or(value);
    let mut url = url::Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return None;
    }
    let mut path = url
        .path()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string();
    if path.is_empty() {
        path = "/".into();
    }
    url.set_path(&path);
    url.set_query(None);
    Some(url.to_string().trim_end_matches('/').to_ascii_lowercase())
}

fn compatibility(manifest: &serde_json::Value) -> Compatibility {
    for field in ["dependencies", "peerDependencies", "optionalDependencies"] {
        let Some(dependencies) = manifest.get(field).and_then(serde_json::Value::as_object) else {
            continue;
        };
        if dependencies.contains_key("cordis") {
            return Compatibility::Incompatible {
                requirement: "legacy cordis".into(),
                reason: "it depends on the legacy Cordis runtime".into(),
            };
        }
    }
    let requirement = ["peerDependencies", "dependencies", "optionalDependencies"]
        .into_iter()
        .find_map(|field| {
            manifest
                .pointer(&format!("/{field}/@deepseek-ai~1dsh"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        });
    let Some(requirement) = requirement else {
        return Compatibility::Unknown;
    };

    let Ok(requirement_parsed) = semver::VersionReq::parse(requirement) else {
        return Compatibility::Incompatible {
            requirement: requirement.to_string(),
            reason: "the package declares an unreadable peer dependency range".to_string(),
        };
    };
    let current = semver::Version::parse(crate::harness::install::VERSION)
        .expect("the pinned Harness version is valid semver");
    if requirement_parsed.matches(&current) {
        Compatibility::Compatible {
            requirement: requirement.to_string(),
        }
    } else {
        Compatibility::Incompatible {
            requirement: requirement.to_string(),
            reason: format!("it requires {requirement}"),
        }
    }
}

/// The registry npm resolves to, without a trailing slash.
async fn base(node: &Path) -> String {
    REGISTRY
        .get_or_init(|| async { ask_npm(node).await })
        .await
        .clone()
}

async fn ask_npm(node: &Path) -> String {
    let Some(npm) = install::npm_cli(node) else {
        return DEFAULT_REGISTRY.to_string();
    };

    let mut command = Command::new(node);
    command
        .arg(npm)
        .arg("config")
        .arg("get")
        .arg("registry")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }

    let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(15), command.output()).await
    else {
        return DEFAULT_REGISTRY.to_string();
    };

    let answer = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // npm prints `undefined` when a key is unset, and prints its usage text
    // when it dislikes the arguments. Either way, the public registry is the
    // right thing to fall back to.
    if answer.starts_with("http") {
        answer.trim_end_matches('/').to_string()
    } else {
        DEFAULT_REGISTRY.to_string()
    }
}

fn listing(entry: &serde_json::Value) -> Option<Listing> {
    let package = entry.get("package")?;
    let links = package.get("links");

    let repository = links.and_then(|links| string(links, "repository"));
    Some(Listing {
        name: string(package, "name")?,
        version: string(package, "version").unwrap_or_default(),
        description: string(package, "description").unwrap_or_default(),
        publisher: package
            .pointer("/publisher/username")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        updated: string(package, "date").unwrap_or_default(),
        weekly_downloads: entry
            .pointer("/downloads/weekly")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or_default(),
        link: links.and_then(|links| {
            ["homepage", "repository", "npm"]
                .into_iter()
                .find_map(|key| string(links, key))
        }),
        repository,
        source_id: "npm".to_string(),
        source_label: "npm registry".to_string(),
        installable: true,
        categories: keywords(package),
        has_icon: false,
        icon: None,
    })
}

fn keywords(package: &serde_json::Value) -> Vec<String> {
    let values: Vec<&str> = match package.get("keywords") {
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect(),
        Some(serde_json::Value::String(value)) => value.split(',').collect(),
        _ => Vec::new(),
    };
    let mut categories: Vec<String> = values
        .into_iter()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 48)
        .take(20)
        .map(str::to_string)
        .collect();
    categories.sort_by_key(|value| value.to_ascii_lowercase());
    categories.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    categories
}

fn string(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{
        compatibility, detail_from_manifest, exact_requested_version, listing, repository_identity,
        validate_preflight, Compatibility,
    };

    #[test]
    fn reads_one_search_result() {
        let entry = serde_json::json!({
            "downloads": { "weekly": 421, "monthly": 1800 },
            "package": {
                "name": "@vendor/dsh-notes",
                "version": "0.2.4",
                "description": "notes as a profile layer",
                "date": "2026-08-16T06:46:50.294Z",
                "publisher": { "username": "vendor" },
                "links": { "repository": "https://example.invalid/notes" }
            }
        });

        let listing = listing(&entry).expect("a well-formed result");
        assert_eq!(listing.name, "@vendor/dsh-notes");
        assert_eq!(listing.weekly_downloads, 421);
        assert_eq!(listing.publisher, "vendor");
        assert_eq!(
            listing.link.as_deref(),
            Some("https://example.invalid/notes")
        );
        assert_eq!(
            listing.repository.as_deref(),
            Some("https://example.invalid/notes")
        );
    }

    #[test]
    fn survives_a_result_missing_everything_optional() {
        let entry = serde_json::json!({ "package": { "name": "bare" } });

        let listing = listing(&entry).expect("a name is enough");
        assert_eq!(listing.name, "bare");
        assert_eq!(listing.weekly_downloads, 0);
        assert!(listing.link.is_none());
        assert!(listing.repository.is_none());
    }

    #[test]
    fn skips_a_result_with_no_package_at_all() {
        assert!(listing(&serde_json::json!({ "downloads": { "weekly": 1 } })).is_none());
    }

    #[test]
    fn detail_pins_the_registry_version_and_records_its_source() {
        let detail = detail_from_manifest(
            "@vendor/tool",
            "https://registry.example",
            &serde_json::json!({
                "name": "@vendor/tool",
                "version": "1.2.3",
                "peerDependencies": { "@deepseek-ai/dsh": "^0.1.1-rc.1" }
            }),
        );
        assert_eq!(detail.install_spec, "@vendor/tool@1.2.3");
        assert_eq!(detail.source, "https://registry.example");
        assert!(matches!(
            detail.compatibility,
            Compatibility::Compatible { .. }
        ));
    }

    #[test]
    fn incompatible_and_malformed_peer_ranges_are_blocked() {
        let previous_prerelease_line = compatibility(&serde_json::json!({
            "peerDependencies": { "@deepseek-ai/dsh": "^0.1.0-rc.7" }
        }));
        assert!(matches!(
            previous_prerelease_line,
            Compatibility::Incompatible { .. }
        ));

        let incompatible = compatibility(&serde_json::json!({
            "peerDependencies": { "@deepseek-ai/dsh": "<0.1.0-rc.7" }
        }));
        assert!(matches!(incompatible, Compatibility::Incompatible { .. }));

        let malformed = compatibility(&serde_json::json!({
            "peerDependencies": { "@deepseek-ai/dsh": "not a range" }
        }));
        assert!(matches!(malformed, Compatibility::Incompatible { .. }));

        let legacy = compatibility(&serde_json::json!({
            "dependencies": { "cordis": "^3.0.0" }
        }));
        assert!(matches!(legacy, Compatibility::Incompatible { .. }));
    }

    #[test]
    fn lifecycle_deprecation_and_weak_integrity_are_market_blocks() {
        let integrity = format!("sha512-{}==", "A".repeat(86));
        let safe = detail_from_manifest(
            "safe-plugin",
            "npm",
            &serde_json::json!({
                "name": "safe-plugin",
                "version": "1.2.3",
                "dist": { "integrity": integrity }
            }),
        );
        assert!(validate_preflight(&safe).is_ok());

        let prerelease = detail_from_manifest(
            "preview-plugin",
            "npm",
            &serde_json::json!({
                "name": "preview-plugin",
                "version": "1.2.3-rc.1",
                "dist": { "integrity": format!("sha512-{}==", "A".repeat(86)) }
            }),
        );
        assert!(validate_preflight(&prerelease).is_ok());

        let build_metadata = detail_from_manifest(
            "ambiguous-plugin",
            "npm",
            &serde_json::json!({
                "name": "ambiguous-plugin",
                "version": "1.2.3+rebuilt",
                "dist": { "integrity": format!("sha512-{}==", "A".repeat(86)) }
            }),
        );
        assert!(validate_preflight(&build_metadata).is_err());

        let scripted = detail_from_manifest(
            "scripted-plugin",
            "npm",
            &serde_json::json!({
                "name": "scripted-plugin",
                "version": "1.2.3",
                "scripts": { "postinstall": "node setup.js" },
                "dist": { "integrity": format!("sha512-{}==", "A".repeat(86)) }
            }),
        );
        assert!(validate_preflight(&scripted).is_err());
        assert_eq!(scripted.lifecycle_scripts, ["postinstall"]);

        let deprecated = detail_from_manifest(
            "old-plugin",
            "npm",
            &serde_json::json!({
                "name": "old-plugin",
                "version": "1.2.3",
                "deprecated": "use another package",
                "dist": { "integrity": "sha1hex-deadbeef" }
            }),
        );
        assert!(validate_preflight(&deprecated).is_err());
    }

    #[test]
    fn market_requests_accept_exact_prereleases_but_not_ranges_tags_or_builds() {
        assert_eq!(
            exact_requested_version("plugin@1.2.3-rc.1").unwrap(),
            "1.2.3-rc.1"
        );
        assert!(exact_requested_version("plugin@^1.2.3").is_err());
        assert!(exact_requested_version("plugin@latest").is_err());
        assert!(exact_requested_version("plugin@1.2.3+rebuilt").is_err());
        assert!(exact_requested_version("plugin").is_err());
    }

    #[test]
    fn repository_backlinks_compare_canonical_https_identity() {
        assert_eq!(
            repository_identity("git+https://GitHub.com/Owner/Repo.git"),
            repository_identity("https://github.com/owner/repo/")
        );
        assert!(repository_identity("git://github.com/owner/repo.git").is_none());
        assert!(repository_identity("https://user@github.com/owner/repo").is_none());
    }
}

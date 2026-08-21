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

use serde::Serialize;
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
const RESULTS: &str = "40";

/// Generous, because this may be a mirror on a slow link.
const BUDGET: Duration = Duration::from_secs(20);

static REGISTRY: OnceCell<String> = OnceCell::const_new();

/// One search result.
#[derive(Debug, Serialize)]
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
    pub source_id: String,
    pub source_label: String,
    pub installable: bool,
}

/// What the published manifest says about one package.
#[derive(Debug, Serialize)]
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
        .append_pair("size", RESULTS);

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
    if let Compatibility::Incompatible { reason, .. } = &detail.compatibility {
        return Err(Error::Plugin(format!(
            "{name} is not compatible with Harness {}: {reason}",
            crate::harness::install::VERSION
        )));
    }
    Ok(detail)
}

fn detail_from_manifest(name: &str, source: &str, manifest: &serde_json::Value) -> Detail {
    let version = string(manifest, "version").unwrap_or_default();
    Detail {
        name: string(&manifest, "name").unwrap_or_else(|| name.to_string()),
        install_spec: format!("{name}@{version}"),
        version,
        description: string(&manifest, "description").unwrap_or_default(),
        license: string(&manifest, "license").unwrap_or_default(),
        homepage: string(&manifest, "homepage"),
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
    }
}

fn compatibility(manifest: &serde_json::Value) -> Compatibility {
    let Some(requirement) = manifest
        .pointer("/peerDependencies/@deepseek-ai~1dsh")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
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
        source_id: "npm".to_string(),
        source_label: "npm registry".to_string(),
        installable: true,
    })
}

fn string(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{compatibility, detail_from_manifest, listing, Compatibility};

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
    }

    #[test]
    fn survives_a_result_missing_everything_optional() {
        let entry = serde_json::json!({ "package": { "name": "bare" } });

        let listing = listing(&entry).expect("a name is enough");
        assert_eq!(listing.name, "bare");
        assert_eq!(listing.weekly_downloads, 0);
        assert!(listing.link.is_none());
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
                "peerDependencies": { "@deepseek-ai/dsh": "^0.1.0-rc.7" }
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
        let incompatible = compatibility(&serde_json::json!({
            "peerDependencies": { "@deepseek-ai/dsh": "<0.1.0-rc.7" }
        }));
        assert!(matches!(incompatible, Compatibility::Incompatible { .. }));

        let malformed = compatibility(&serde_json::json!({
            "peerDependencies": { "@deepseek-ai/dsh": "not a range" }
        }));
        assert!(matches!(malformed, Compatibility::Incompatible { .. }));
    }
}

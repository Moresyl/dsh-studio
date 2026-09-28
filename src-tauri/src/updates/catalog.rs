//! Published application versions, independent of the selected Node runtime.

use std::collections::HashSet;
use std::future::Future;
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::node::http;

pub(super) const REPOSITORY: &str = "Moresyl/dsh-studio";
pub(super) const WEBSITE: &str = "https://moresyl.github.io/dsh-studio";
const PAGE_SIZE: usize = 20;
const MAX_PAGE: u32 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Older,
    Current,
    Newer,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSummary {
    pub version: String,
    pub title: String,
    pub published: String,
    pub url: String,
    pub direction: Direction,
    /// A manifest exists; its platform, identity and signature still need review.
    pub has_updater: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePage {
    pub releases: Vec<ReleaseSummary>,
    pub page: u32,
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct PublishedRelease {
    pub tag_name: String,
    pub name: Option<String>,
    pub draft: bool,
    pub prerelease: bool,
    pub published_at: Option<String>,
    pub assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Asset {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
}

pub(super) fn failure(message: impl Into<String>) -> Error {
    Error::Desktop(message.into())
}

/// Exact stable versions only. This is also the URL path admission boundary.
pub(super) fn stable_version(value: &str) -> Result<Version> {
    if value.len() > 64 {
        return Err(failure("application version is too long"));
    }
    let parsed = Version::parse(value)
        .map_err(|_| failure("application version must be an exact stable version"))?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() || parsed.to_string() != value {
        return Err(failure(
            "application version must be an exact stable version",
        ));
    }
    Ok(parsed)
}

pub(super) fn release_url(version: &str) -> String {
    format!("https://github.com/{REPOSITORY}/releases/tag/v{version}")
}

pub(super) fn release_endpoint(version: &str) -> Result<String> {
    stable_version(version)?;
    Ok(format!(
        "https://api.github.com/repos/{REPOSITORY}/releases/tags/v{version}"
    ))
}

fn page_endpoint(page: u32) -> Result<String> {
    if !(1..=MAX_PAGE).contains(&page) {
        return Err(failure("application version page is out of range"));
    }
    Ok(format!(
        "https://api.github.com/repos/{REPOSITORY}/releases?per_page={PAGE_SIZE}&page={page}"
    ))
}

impl PublishedRelease {
    pub(super) fn version(&self) -> Result<Version> {
        if self.draft || self.prerelease || self.published_at.as_deref().is_none_or(str::is_empty) {
            return Err(failure(
                "only published stable application releases can be installed",
            ));
        }
        stable_version(
            self.tag_name
                .strip_prefix('v')
                .ok_or_else(|| failure("application release tag must begin with v"))?,
        )
    }

    pub(super) fn asset(&self, name: &str) -> Result<&Asset> {
        let mut matches = self.assets.iter().filter(|asset| asset.name == name);
        let asset = matches
            .next()
            .ok_or_else(|| failure(format!("the application release has no {name}")))?;
        if matches.next().is_some() || asset.size == 0 || asset.id == 0 {
            return Err(failure("application release asset is empty or ambiguous"));
        }
        Ok(asset)
    }
}

pub async fn list(page: u32, current: &Version) -> Result<ReleasePage> {
    let endpoint = page_endpoint(page)?;
    read_fallback(
        &endpoint,
        &format!("{WEBSITE}/versions/page-{page}.json"),
        metadata,
        |body| parse_page(body, page, current),
    )
    .await
}

pub(super) async fn published(version: &str) -> Result<PublishedRelease> {
    let endpoint = release_endpoint(version)?;
    read_fallback(
        &endpoint,
        &format!("{WEBSITE}/versions/v{version}.json"),
        metadata,
        |body| parse_release(body, version),
    )
    .await
}

async fn metadata(endpoint: String) -> Result<String> {
    tokio::time::timeout(Duration::from_secs(12), async {
        http::text(&http::client()?, &endpoint).await
    })
    .await
    .map_err(|_| failure("application release metadata timed out"))?
}

async fn read_fallback<T, F, Fut>(
    primary: &str,
    fallback: &str,
    mut fetch: F,
    parse: impl Fn(&str) -> Result<T>,
) -> Result<T>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<String>>,
{
    match fetch(primary.to_owned())
        .await
        .and_then(|body| parse(&body))
    {
        Ok(result) => Ok(result),
        Err(first) => fetch(fallback.to_owned())
            .await
            .and_then(|body| parse(&body))
            .map_err(|second| {
                failure(format!(
                    "application release sources failed: {first}; {second}"
                ))
            }),
    }
}

pub(super) fn parse_release(body: &str, version: &str) -> Result<PublishedRelease> {
    let release: PublishedRelease = serde_json::from_str(body)
        .map_err(|_| failure("application release metadata is unreadable"))?;
    if release.version()? != stable_version(version)? {
        return Err(failure(
            "application release metadata does not match the selected version",
        ));
    }
    Ok(release)
}

fn parse_page(body: &str, page: u32, current: &Version) -> Result<ReleasePage> {
    page_endpoint(page)?;
    let records: Vec<PublishedRelease> = serde_json::from_str(body)
        .map_err(|_| failure("application version catalog is unreadable"))?;
    if records.len() > PAGE_SIZE {
        return Err(failure(
            "application version catalog exceeded its page limit",
        ));
    }
    let has_more = records.len() == PAGE_SIZE && page < MAX_PAGE;
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for record in records {
        let Ok(version) = record.version() else {
            continue;
        };
        if !seen.insert(version.clone()) {
            return Err(failure(
                "application version catalog contains duplicate versions",
            ));
        }
        let direction = match version.cmp(current) {
            std::cmp::Ordering::Less => Direction::Older,
            std::cmp::Ordering::Equal => Direction::Current,
            std::cmp::Ordering::Greater => Direction::Newer,
        };
        let summary = ReleaseSummary {
            version: version.to_string(),
            title: record
                .name
                .as_deref()
                .unwrap_or(&record.tag_name)
                .chars()
                .take(160)
                .collect(),
            published: record.published_at.clone().unwrap_or_default(),
            url: release_url(&version.to_string()),
            direction,
            has_updater: record.asset("latest.json").is_ok(),
        };
        entries.push((version, summary));
    }
    entries.sort_by(|left, right| right.0.cmp(&left.0));
    Ok(ReleasePage {
        releases: entries.into_iter().map(|(_, entry)| entry).collect(),
        page,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn healthy_primary_does_not_contact_fallback() {
        let mut calls = Vec::new();
        let result = read_fallback(
            "primary",
            "fallback",
            |url| {
                calls.push(url);
                std::future::ready(Ok(record("1.0.0").to_string()))
            },
            |body| parse_release(body, "1.0.0"),
        )
        .await
        .unwrap();
        assert_eq!(result.version().unwrap(), Version::new(1, 0, 0));
        assert_eq!(calls, ["primary"]);
    }

    #[tokio::test]
    async fn network_and_parse_failures_try_the_same_validated_fallback() {
        for primary in [
            Err(failure("API rate limited")),
            Ok("{}".into()),
            Ok(record("2.0.0").to_string()),
        ] {
            let mut results = [primary, Ok(record("1.0.0").to_string())].into_iter();
            let mut calls = Vec::new();
            let result = read_fallback(
                "primary",
                "fallback",
                |url| {
                    calls.push(url);
                    std::future::ready(results.next().unwrap())
                },
                |body| parse_release(body, "1.0.0"),
            )
            .await
            .unwrap();
            assert_eq!(result.version().unwrap(), Version::new(1, 0, 0));
            assert_eq!(calls, ["primary", "fallback"]);
        }
    }

    #[tokio::test]
    async fn fallback_cannot_bypass_release_identity_or_hide_both_failures() {
        let mut results = [
            Err(failure("API rate limited")),
            Ok(record("2.0.0").to_string()),
        ]
        .into_iter();
        let failure = read_fallback(
            "primary",
            "fallback",
            |_| std::future::ready(results.next().unwrap()),
            |body| parse_release(body, "1.0.0"),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(failure.contains("API rate limited"));
        assert!(failure.contains("does not match"));
    }

    fn record(version: &str) -> Value {
        json!({
            "tag_name": format!("v{version}"), "name": null, "body": "Release notes",
            "draft": false, "prerelease": false, "published_at": "2026-09-29T00:00:00Z",
            "assets": [{"id": 1, "name": "latest.json", "size": 20,
                "browser_download_url": "https://github.com/Moresyl/dsh-studio/releases/download/v1.0.0/latest.json"}]
        })
    }

    fn page(records: Vec<Value>) -> Result<ReleasePage> {
        parse_page(
            &serde_json::to_string(&records).unwrap(),
            1,
            &Version::new(1, 2, 0),
        )
    }

    #[test]
    fn catalog_orders_semantic_versions_and_marks_current_and_older() {
        let parsed = page(vec![
            record("1.9.0"),
            record("1.10.0"),
            record("1.1.0"),
            record("1.2.0"),
        ])
        .unwrap();
        assert_eq!(
            parsed
                .releases
                .iter()
                .map(|item| item.version.as_str())
                .collect::<Vec<_>>(),
            ["1.10.0", "1.9.0", "1.2.0", "1.1.0"]
        );
        assert_eq!(parsed.releases[0].direction, Direction::Newer);
        assert_eq!(parsed.releases[2].direction, Direction::Current);
        assert_eq!(parsed.releases[3].direction, Direction::Older);
        assert!(parsed.releases[0].has_updater);
        assert!(!parsed.has_more);
    }

    #[test]
    fn draft_prerelease_unpublished_and_invalid_versions_are_not_offered() {
        let mut draft = record("1.0.0");
        draft["draft"] = json!(true);
        let mut preview = record("2.0.0");
        preview["prerelease"] = json!(true);
        let mut unpublished = record("3.0.0");
        unpublished["published_at"] = Value::Null;
        assert!(page(vec![
            draft,
            preview,
            unpublished,
            record("1.0.0-rc.1"),
            record("../evil")
        ])
        .unwrap()
        .releases
        .is_empty());
    }

    #[test]
    fn unsafe_version_strings_never_enter_an_endpoint() {
        for version in [
            "",
            "v1.2.3",
            " 1.2.3",
            "1.2",
            "01.2.3",
            "1.2.3/evil",
            "1.2.3?x=y",
            "1.2.3+build",
            "1.2.3-rc.1",
            "../1.2.3",
        ] {
            assert!(release_endpoint(version).is_err(), "{version}");
        }
        assert!(stable_version(&"1".repeat(65)).is_err());
        assert_eq!(
            release_endpoint("1.2.3").unwrap(),
            "https://api.github.com/repos/Moresyl/dsh-studio/releases/tags/v1.2.3"
        );
    }

    #[test]
    fn pagination_remains_available_when_a_full_page_contains_filtered_records() {
        let records = (0..20)
            .map(|index| record(&format!("1.0.{index}-rc.1")))
            .collect();
        let parsed = page(records).unwrap();
        assert!(parsed.releases.is_empty());
        assert!(parsed.has_more);
        assert!(page_endpoint(0).is_err());
        assert!(page_endpoint(101).is_err());
        assert!(page_endpoint(100).is_ok());
        assert!(page(
            (0..21)
                .map(|index| record(&format!("1.0.{index}")))
                .collect()
        )
        .is_err());
    }

    #[test]
    fn malformed_or_ambiguous_records_are_errors_not_empty_successes() {
        assert!(parse_page("{}", 1, &Version::new(1, 0, 0)).is_err());
        assert!(page(vec![record("1.0.0"), record("1.0.0")]).is_err());
        assert!(parse_release("[]", "1.0.0").is_err());
        assert!(parse_release(&record("1.0.1").to_string(), "1.0.0").is_err());
    }

    #[test]
    fn missing_empty_or_duplicate_manifests_still_allow_reading_release_notes() {
        let mut missing = record("1.0.0");
        missing["assets"] = json!([]);
        let mut empty = record("1.0.1");
        empty["assets"][0]["size"] = json!(0);
        let mut duplicate = record("1.0.2");
        duplicate["assets"] = json!([duplicate["assets"][0], duplicate["assets"][0]]);
        let parsed = page(vec![missing, empty, duplicate]).unwrap();
        assert_eq!(parsed.releases.len(), 3);
        assert!(parsed.releases.iter().all(|entry| !entry.has_updater));
        assert_eq!(
            parsed.releases[0].url,
            "https://github.com/Moresyl/dsh-studio/releases/tag/v1.0.2"
        );
    }
}

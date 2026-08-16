//! Whether a newer build of this shell has been published.
//!
//! Checking is something the user asks for, not something that happens quietly
//! at startup: an app that phones home on launch has made a decision on the
//! user's behalf about what their machine tells the internet. Nothing here
//! downloads or installs anything either — it reads a version number and hands
//! over a link, and the user decides.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::error::Result;
use crate::fetch;

/// The published release feed for this project.
const FEED: &str = "https://api.github.com/repos/Moresyl/dsh-studio/releases/latest";

const BUDGET: Duration = Duration::from_secs(15);

/// What the About panel shows after a check.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    /// The published version, without any leading `v`.
    pub version: String,
    /// True only when it is actually newer than what is running.
    pub newer: bool,
    /// Where to read about it and download it.
    pub url: String,
    pub notes: String,
    pub published: String,
}

/// Ask the release feed what the newest published version is.
pub async fn latest(node: &Path, current: &str) -> Result<Release> {
    let feed = fetch::json(node, FEED, BUDGET).await?;
    let version = feed
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim_start_matches('v')
        .to_string();

    Ok(Release {
        newer: is_newer(&version, current),
        url: feed
            .get("html_url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("https://github.com/Moresyl/dsh-studio/releases")
            .to_string(),
        notes: feed
            .get("body")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        published: feed
            .get("published_at")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        version,
    })
}

/// Whether `candidate` is a later version than `current`.
///
/// Semantic versions, compared the way the spec says: numerically by release,
/// and with a pre-release ranking below the release it leads to — so a user
/// running `0.3.0` is not told that `0.3.0-rc.1` is an upgrade.
fn is_newer(candidate: &str, current: &str) -> bool {
    let (candidate_release, candidate_pre) = split_version(candidate);
    let (current_release, current_pre) = split_version(current);

    match candidate_release.cmp(&current_release) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        // Same numbers: only a full release beats a pre-release of it.
        std::cmp::Ordering::Equal => current_pre.is_some() && candidate_pre.is_none(),
    }
}

/// `1.2.3-rc.1` becomes `([1, 2, 3], Some("rc.1"))`.
fn split_version(version: &str) -> ([u64; 3], Option<&str>) {
    let trimmed = version.trim().trim_start_matches('v');
    let (release, pre) = match trimmed.split_once(['-', '+']) {
        Some((release, pre)) => (release, Some(pre)),
        None => (trimmed, None),
    };

    let mut parts = [0u64; 3];
    for (slot, value) in parts.iter_mut().zip(release.split('.')) {
        *slot = value.parse().unwrap_or_default();
    }
    (parts, pre.filter(|pre| !pre.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::{is_newer, split_version};

    #[test]
    fn compares_releases_by_number_not_by_text() {
        assert!(is_newer("0.10.0", "0.9.0"), "10 is not less than 9");
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
    }

    #[test]
    fn tolerates_the_tag_prefix_a_release_feed_uses() {
        assert!(is_newer("v0.3.0", "0.2.0"));
        assert_eq!(split_version("v1.2.3").0, [1, 2, 3]);
    }

    #[test]
    fn ranks_a_pre_release_below_the_release_it_leads_to() {
        assert!(!is_newer("0.3.0-rc.1", "0.3.0"));
        assert!(is_newer("0.3.0", "0.3.0-rc.1"));
        assert!(is_newer("0.3.0-rc.1", "0.2.9"));
    }

    #[test]
    fn treats_a_short_or_broken_version_as_zeroes_rather_than_failing() {
        assert_eq!(split_version("2").0, [2, 0, 0]);
        assert_eq!(split_version("2.1").0, [2, 1, 0]);
        assert_eq!(split_version("nonsense").0, [0, 0, 0]);
    }
}

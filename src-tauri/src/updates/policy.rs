//! Bind an updater response to the selected public release's actual assets.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::error::Result;

use super::catalog::{failure, stable_version, PublishedRelease, REPOSITORY};

pub(super) const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

pub(super) fn install_block(
    candidate: &Candidate,
    current: &semver::Version,
    development: bool,
) -> Result<Option<&'static str>> {
    if development {
        return Ok(Some("development"));
    }
    // The upstream RPM installer uses `rpm -U`, which refuses older packages.
    // Do not stop the user's runtime for an operation that cannot succeed.
    if candidate.artifact.ends_with(".rpm") && stable_version(&candidate.version)? < *current {
        return Ok(Some("rpmDowngrade"));
    }
    Ok(None)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Candidate {
    pub version: String,
    pub notes: String,
    pub published: String,
    pub artifact: String,
    pub asset_id: u64,
    pub bytes: u64,
    pub download_url: String,
    pub signature: String,
}

impl Candidate {
    pub(super) fn fingerprint(&self) -> Result<String> {
        let encoded = serde_json::to_vec(self)
            .map_err(|_| failure("application review cannot be encoded"))?;
        Ok(format!("{:x}", Sha256::digest(encoded)))
    }
}

pub(super) struct Offer<'a> {
    pub version: &'a str,
    pub notes: &'a str,
    pub download_url: &'a str,
    pub signature: &'a str,
}

pub(super) fn asset_url(version: &str, name: &str) -> Result<String> {
    stable_version(version)?;
    if name.is_empty()
        || name.len() > 255
        || name.contains(['/', '\\', '\0'])
        || name == "."
        || name == ".."
    {
        return Err(failure("application release contains an unsafe asset name"));
    }
    let mut url = Url::parse(&format!(
        "https://github.com/{REPOSITORY}/releases/download/v{version}/"
    ))
    .map_err(|_| failure("application release URL is invalid"))?;
    url.path_segments_mut()
        .map_err(|_| failure("application release URL cannot contain asset paths"))?
        .pop_if_empty()
        .push(name);
    Ok(url.to_string())
}

pub(super) fn bind(
    offer: Offer<'_>,
    release: &PublishedRelease,
    platform: &str,
) -> Result<Candidate> {
    let version = stable_version(offer.version)?;
    if release.version()? != version {
        return Err(failure(
            "the update does not belong to the selected application release",
        ));
    }
    if offer.notes.len() > 128 * 1024
        || offer.signature.trim().is_empty()
        || offer.signature.len() > 4096
    {
        return Err(failure("application update notes or signature are invalid"));
    }
    let mut matches = release.assets.iter().filter(|asset| {
        offer.download_url == asset.browser_download_url
            || offer.download_url
                == format!(
                    "https://api.github.com/repos/{REPOSITORY}/releases/assets/{}",
                    asset.id
                )
    });
    let selected = matches.next().ok_or_else(|| {
        failure("the updater download is not an asset of this application release")
    })?;
    if matches.next().is_some() {
        return Err(failure("the updater download is ambiguous"));
    }
    let selected = release.asset(&selected.name)?;
    if selected.browser_download_url != asset_url(offer.version, &selected.name)? {
        return Err(failure(
            "application download URL is not owned by this release",
        ));
    }
    let kind_matches = match platform {
        "windows" => selected.name.ends_with(".exe") || selected.name.ends_with(".msi"),
        "macos" => selected.name.ends_with(".app.tar.gz"),
        "linux" => [".AppImage", ".deb", ".rpm"]
            .iter()
            .any(|suffix| selected.name.ends_with(suffix)),
        _ => false,
    };
    if !kind_matches || selected.name.contains("-full-") || selected.size > MAX_DOWNLOAD_BYTES {
        return Err(failure(
            "application updater artifact is unsupported for this platform",
        ));
    }
    let signature = release.asset(&format!("{}.sig", selected.name))?;
    if signature.size > 4096
        || signature.browser_download_url != asset_url(offer.version, &signature.name)?
    {
        return Err(failure("application signature asset is invalid"));
    }
    Ok(Candidate {
        version: offer.version.to_string(),
        notes: offer.notes.trim().to_string(),
        published: release.published_at.clone().unwrap_or_default(),
        artifact: selected.name.clone(),
        asset_id: selected.id,
        bytes: selected.size,
        download_url: offer.download_url.to_string(),
        signature: offer.signature.trim().to_string(),
    })
}

pub(super) fn unchanged(reviewed: &Candidate, current: &Candidate) -> Result<()> {
    if reviewed != current {
        return Err(failure(
            "the application release changed after review; review its version and notes again",
        ));
    }
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rpm_downgrades_require_the_system_package_manager() {
        let mut release = candidate();
        release.artifact = "studio.rpm".into();
        assert_eq!(
            install_block(&release, &semver::Version::new(2, 0, 0), false).unwrap(),
            Some("rpmDowngrade")
        );
        assert_eq!(
            install_block(&release, &semver::Version::new(1, 2, 3), false).unwrap(),
            None
        );
        assert_eq!(
            install_block(&release, &semver::Version::new(1, 0, 0), false).unwrap(),
            None
        );
        release.artifact = "studio.exe".into();
        assert_eq!(
            install_block(&release, &semver::Version::new(2, 0, 0), false).unwrap(),
            None
        );
        assert_eq!(
            install_block(&release, &semver::Version::new(2, 0, 0), true).unwrap(),
            Some("development")
        );
    }

    pub(in crate::updates) fn candidate() -> Candidate {
        Candidate {
            version: "1.2.3".into(),
            notes: "Notes".into(),
            published: "2026-09-29T00:00:00Z".into(),
            artifact: "Studio.exe".into(),
            asset_id: 11,
            bytes: 100,
            download_url: asset_url("1.2.3", "Studio.exe").unwrap(),
            signature: "signature".into(),
        }
    }

    fn release() -> PublishedRelease {
        serde_json::from_value(json!({
            "tag_name": "v1.2.3", "name": "Version", "draft": false, "prerelease": false,
            "published_at": "2026-09-29T00:00:00Z", "assets": [
                {"id": 11, "name": "Studio.exe", "size": 100, "browser_download_url": asset_url("1.2.3", "Studio.exe").unwrap()},
                {"id": 12, "name": "Studio.exe.sig", "size": 20, "browser_download_url": asset_url("1.2.3", "Studio.exe.sig").unwrap()}
            ]
        })).unwrap()
    }

    fn offer(candidate: &Candidate) -> Offer<'_> {
        Offer {
            version: &candidate.version,
            notes: &candidate.notes,
            download_url: &candidate.download_url,
            signature: &candidate.signature,
        }
    }

    #[test]
    fn accepts_only_the_selected_releases_download_or_asset_api_url() {
        let mut source = candidate();
        assert_eq!(bind(offer(&source), &release(), "windows").unwrap(), source);
        source.download_url =
            "https://api.github.com/repos/Moresyl/dsh-studio/releases/assets/11".into();
        assert!(bind(offer(&source), &release(), "windows").is_ok());
        for url in [
            "http://github.com/Moresyl/dsh-studio/releases/assets/11",
            "https://example.com/Studio.exe",
            "https://api.github.com/repos/other/project/releases/assets/11",
            "https://api.github.com/repos/Moresyl/dsh-studio/releases/assets/13",
        ] {
            source.download_url = url.into();
            assert!(
                bind(offer(&source), &release(), "windows").is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn rejects_missing_signature_wrong_platform_and_mismatched_version() {
        let source = candidate();
        let mut metadata = release();
        metadata.assets.pop();
        assert!(bind(offer(&source), &metadata, "windows").is_err());
        assert!(bind(offer(&source), &release(), "macos").is_err());
        assert!(bind(offer(&source), &release(), "unknown").is_err());
        metadata = release();
        metadata.tag_name = "v1.2.4".into();
        assert!(bind(offer(&source), &metadata, "windows").is_err());
    }

    #[test]
    fn rejects_forged_or_oversized_asset_metadata() {
        let source = candidate();
        let mut metadata = release();
        metadata.assets[0].size = MAX_DOWNLOAD_BYTES + 1;
        assert!(bind(offer(&source), &metadata, "windows").is_err());
        metadata = release();
        metadata.assets[1].browser_download_url = "https://example.com/signature".into();
        assert!(bind(offer(&source), &metadata, "windows").is_err());
        metadata = release();
        metadata.assets[1].size = 4097;
        assert!(bind(offer(&source), &metadata, "windows").is_err());
        metadata = release();
        metadata.assets[0].browser_download_url = "https://example.com/Studio.exe".into();
        let mut forged = source;
        forged.download_url = metadata.assets[0].browser_download_url.clone();
        assert!(bind(offer(&forged), &metadata, "windows").is_err());
    }

    #[test]
    fn names_cannot_escape_the_release_path_and_spaces_are_encoded() {
        for name in ["", "..", ".", "../file", "a/b.exe", "a\\b.exe", "a\0b"] {
            assert!(asset_url("1.2.3", name).is_err(), "{name}");
        }
        assert!(asset_url("1.2.3", &"a".repeat(256)).is_err());
        assert!(asset_url("1.2.3", "DSH Studio.exe")
            .unwrap()
            .ends_with("/DSH%20Studio.exe"));
    }

    #[test]
    fn rejects_mutated_notes_signature_size_and_asset_identity_after_review() {
        let reviewed = candidate();
        assert_eq!(reviewed.fingerprint().unwrap().len(), 64);
        assert!(unchanged(&reviewed, &reviewed).is_ok());
        for key in [
            "version",
            "notes",
            "signature",
            "artifact",
            "download_url",
            "published",
        ] {
            let mut json = serde_json::to_value(&reviewed).unwrap();
            json[key] = json!("changed");
            let changed = serde_json::from_value(json).unwrap();
            assert!(unchanged(&reviewed, &changed).is_err(), "{key}");
            assert_ne!(
                reviewed.fingerprint().unwrap(),
                changed.fingerprint().unwrap()
            );
        }
        let mut changed = reviewed.clone();
        changed.bytes += 1;
        assert!(unchanged(&reviewed, &changed).is_err());
        changed = reviewed.clone();
        changed.asset_id += 1;
        assert!(unchanged(&reviewed, &changed).is_err());
    }
}

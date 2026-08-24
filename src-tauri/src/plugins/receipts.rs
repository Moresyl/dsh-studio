//! Durable provenance for packages installed through the market.
//!
//! The receipt lives inside the profile and is one of the files captured by
//! plugin recovery. An install is therefore never committed with half a
//! receipt, and a killed process restores both the package declaration and its
//! provenance together.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::registry::Detail;
use crate::error::{Error, Result};

pub const FILE: &str = ".dsh-studio-market.json";
const SCHEMA: u8 = 1;
const MAX_RECEIPTS: usize = 512;
const MAX_FILE: u64 = 2 << 20;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub receipt_id: String,
    pub profile_name: String,
    pub package_name: String,
    pub version: String,
    pub integrity: String,
    pub bundle_patch: Option<serde_json::Value>,
    pub source_record_id: String,
    pub provider_id: String,
    pub item_id: String,
    pub display_name: String,
    pub installed_at: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Store {
    schema: u8,
    receipts: Vec<Receipt>,
}

pub fn ids(profile: &str, profile_dir: &Path) -> BTreeMap<String, String> {
    load(profile, profile_dir)
        .map(|store| {
            store
                .receipts
                .into_iter()
                .filter(|receipt| {
                    installed_version(profile_dir, &receipt.package_name).as_deref()
                        == Some(receipt.version.as_str())
                })
                .map(|receipt| (receipt.package_name, receipt.receipt_id))
                .collect()
        })
        .unwrap_or_default()
}

fn installed_version(profile_dir: &Path, package_name: &str) -> Option<String> {
    let manifest = profile_dir
        .join("node_modules")
        .join(package_name)
        .join("package.json");
    let body = std::fs::read(manifest).ok()?;
    serde_json::from_slice::<serde_json::Value>(&body)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

pub fn record(
    profile: &str,
    profile_dir: &Path,
    source_id: &str,
    item_id: &str,
    display_name: &str,
    detail: &Detail,
) -> Result<()> {
    let integrity = detail.integrity.clone().ok_or_else(|| {
        Error::Plugin(format!(
            "{} has no registry integrity and cannot be installed as a managed market item",
            detail.install_spec
        ))
    })?;
    if !valid_integrity(&integrity) {
        return Err(Error::Plugin(format!(
            "{} returned an invalid registry integrity",
            detail.install_spec
        )));
    }
    if !super::is_package_name(&detail.name) || detail.version.trim().is_empty() {
        return Err(Error::Plugin("the resolved market item is invalid".into()));
    }
    if detail
        .bundle_patch
        .as_ref()
        .is_some_and(|patch| serde_json::to_vec(patch).map_or(true, |body| body.len() > 256 << 10))
    {
        return Err(Error::Plugin(
            "the published profile patch is too large for a market receipt".into(),
        ));
    }

    let mut store = load(profile, profile_dir)?;
    store
        .receipts
        .retain(|receipt| receipt.package_name != detail.name);
    if store.receipts.len() >= MAX_RECEIPTS {
        return Err(Error::Plugin(
            "the profile has too many market receipts".into(),
        ));
    }
    let installed_at = now();
    store.receipts.push(Receipt {
        receipt_id: receipt_id(profile, source_id, item_id, detail, installed_at),
        profile_name: profile.to_string(),
        package_name: detail.name.clone(),
        version: detail.version.clone(),
        integrity,
        bundle_patch: detail.bundle_patch.clone(),
        source_record_id: source_id.to_string(),
        provider_id: match source_id {
            "npm" => "npm",
            super::catalog::DSHFIND_ID => "com.dshfind.catalog",
            _ => "standard-http-v1",
        }
        .to_string(),
        item_id: item_id.to_string(),
        display_name: clean_display(display_name, &detail.name),
        installed_at,
    });
    store
        .receipts
        .sort_by(|left, right| left.package_name.cmp(&right.package_name));
    save(profile_dir, &store)
}

pub fn remove(profile: &str, profile_dir: &Path, package_name: &str) -> Result<()> {
    let mut store = load(profile, profile_dir)?;
    let before = store.receipts.len();
    store
        .receipts
        .retain(|receipt| receipt.package_name != package_name);
    if store.receipts.len() == before {
        return Ok(());
    }
    save(profile_dir, &store)
}

fn load(profile: &str, profile_dir: &Path) -> Result<Store> {
    let path = profile_dir.join(FILE);
    let Ok(metadata) = std::fs::symlink_metadata(&path) else {
        return Ok(Store {
            schema: SCHEMA,
            receipts: Vec::new(),
        });
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_FILE {
        return Err(Error::Plugin("the market receipt store is unsafe".into()));
    }
    let body = std::fs::read(&path)
        .map_err(|cause| Error::Plugin(format!("could not read market receipts: {cause}")))?;
    let store: Store = serde_json::from_slice(&body)
        .map_err(|cause| Error::Plugin(format!("market receipts are invalid: {cause}")))?;
    validate(profile, &store)?;
    Ok(store)
}

fn validate(profile: &str, store: &Store) -> Result<()> {
    if store.schema != SCHEMA || store.receipts.len() > MAX_RECEIPTS {
        return Err(Error::Plugin(
            "the market receipt store has an unsupported shape".into(),
        ));
    }
    let mut packages = BTreeSet::new();
    for receipt in &store.receipts {
        if receipt.profile_name != profile
            || !super::is_package_name(&receipt.package_name)
            || receipt.version.trim().is_empty()
            || !valid_integrity(&receipt.integrity)
            || receipt.receipt_id.len() != 32
            || receipt.source_record_id.is_empty()
            || receipt.source_record_id.len() > 128
            || receipt.item_id != receipt.package_name
            || receipt.display_name.is_empty()
            || receipt.display_name.len() > 160
            || !packages.insert(receipt.package_name.clone())
        {
            return Err(Error::Plugin(
                "the market receipt store failed validation".into(),
            ));
        }
    }
    Ok(())
}

fn save(profile_dir: &Path, store: &Store) -> Result<()> {
    std::fs::create_dir_all(profile_dir)
        .map_err(|cause| Error::Plugin(format!("could not create the profile: {cause}")))?;
    let body = serde_json::to_vec_pretty(store)
        .map_err(|cause| Error::Plugin(format!("could not encode market receipts: {cause}")))?;
    if body.len() as u64 > MAX_FILE {
        return Err(Error::Plugin(
            "the market receipt store is too large".into(),
        ));
    }
    let path = profile_dir.join(FILE);
    crate::atomic::write(&path, body)
        .map_err(|cause| Error::Plugin(format!("could not commit market receipts: {cause}")))
}

fn valid_integrity(value: &str) -> bool {
    value.len() <= 512
        && !value.chars().any(char::is_whitespace)
        && (value.starts_with("sha512-")
            || value.starts_with("sha384-")
            || value.starts_with("sha256-")
            || value.starts_with("sha1hex-"))
}

fn clean_display(value: &str, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() || value.len() > 160 || value.chars().any(char::is_control) {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn receipt_id(
    profile: &str,
    source_id: &str,
    item_id: &str,
    detail: &Detail,
    installed_at: u64,
) -> String {
    let digest = Sha256::digest(
        format!(
            "{profile}\0{source_id}\0{item_id}\0{}\0{}\0{installed_at}",
            detail.name, detail.version
        )
        .as_bytes(),
    );
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::{ids, receipt_id, record, remove, valid_integrity};
    use crate::plugins::registry::{Compatibility, Detail};

    fn detail() -> Detail {
        Detail {
            name: "@vendor/tool".into(),
            version: "1.2.3".into(),
            description: String::new(),
            license: String::new(),
            homepage: None,
            repository: None,
            bundle: true,
            dependencies: Vec::new(),
            install_spec: "@vendor/tool@1.2.3".into(),
            source: "npm".into(),
            compatibility: Compatibility::Unknown,
            integrity: Some("sha512-YWJj".into()),
            bundle_patch: Some(serde_json::json!({"profile": {}})),
            lifecycle_scripts: Vec::new(),
            deprecated: None,
            repository_verified: true,
            integrity_verified: true,
        }
    }

    #[test]
    fn receipt_ids_are_stable_and_scoped() {
        let detail = detail();
        let id = receipt_id("web", "npm", "tool", &detail, 42);
        assert_eq!(id.len(), 32);
        assert_eq!(id, receipt_id("web", "npm", "tool", &detail, 42));
        assert_ne!(id, receipt_id("other", "npm", "tool", &detail, 42));
    }

    #[test]
    fn integrity_must_name_a_supported_digest_without_whitespace() {
        assert!(valid_integrity("sha512-YWJj"));
        assert!(!valid_integrity("YWJj"));
        assert!(!valid_integrity("sha512-a b"));
    }

    #[test]
    fn records_replaces_and_removes_profile_provenance() {
        let directory = std::env::temp_dir().join(format!(
            "dsh-studio-receipts-{}-{}",
            std::process::id(),
            super::now()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let installed = directory.join("node_modules").join("@vendor").join("tool");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(installed.join("package.json"), br#"{"version":"1.2.3"}"#).unwrap();
        let detail = detail();
        record("web", &directory, "npm", "@vendor/tool", "Tool", &detail).unwrap();
        let first = ids("web", &directory);
        assert_eq!(first.len(), 1);
        assert!(first.contains_key("@vendor/tool"));

        record("web", &directory, "npm", "@vendor/tool", "Tool", &detail).unwrap();
        assert_eq!(ids("web", &directory).len(), 1);
        remove("web", &directory, "@vendor/tool").unwrap();
        assert!(ids("web", &directory).is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

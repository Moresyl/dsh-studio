//! Plugins that are installed but switched off.
//!
//! The harness has no idea of an installed plugin that is not running. After
//! every plugin command it reconciles `dsh.profile.bundles` against what is on
//! disk, so a name taken out of that list is put straight back the next time
//! anything is installed or removed. Switching a plugin off without
//! uninstalling it therefore has to be a fact the shell keeps and re-asserts,
//! which is all this module is.
//!
//! The manifest still belongs to the harness. Nothing here invents a layer: it
//! takes out a name the user switched off and puts back the one they switched
//! on again. If a name put back turns out not to declare a patch after all, the
//! harness's own reconciliation drops it — the rule stays in one place, and the
//! shell does not need a copy of it to be correct.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::{Error, Result};
use crate::paths;

/// Where the shell records what the user switched off, keyed by profile so the
/// answer stays right if the shell ever hosts more than one.
fn store() -> PathBuf {
    paths::app_data_dir().join("plugins.json")
}

/// Names the user switched off in this profile. Never fails: an unreadable or
/// half-written file means nothing is switched off, which is the state the
/// harness would boot in anyway.
pub fn switched_off(profile: &str) -> BTreeSet<String> {
    let Ok(raw) = std::fs::read_to_string(store()) else {
        return BTreeSet::new();
    };
    let Ok(document) = serde_json::from_str::<Value>(&raw) else {
        return BTreeSet::new();
    };

    document
        .get("disabled")
        .and_then(|disabled| disabled.get(profile))
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Switch one plugin on or off, and make the profile agree straight away.
///
/// Both halves matter. The record is what survives the harness reconciling the
/// layer list from what is installed; the manifest edit is what makes the
/// change real at the next start rather than at the next install.
pub fn set(profile: &str, name: &str, enabled: bool, profile_dir: &Path) -> Result<()> {
    let mut off = switched_off(profile);
    let changed = if enabled {
        off.remove(name)
    } else {
        off.insert(name.to_string())
    };
    if changed {
        remember(profile, &off)?;
    }

    if enabled {
        relist(profile_dir, name)
    } else {
        apply(profile, profile_dir)
    }
}

/// Make the profile's layer list agree with what the user switched off.
///
/// A no-op when nothing differs, so it is safe to call after every plugin
/// command — which is exactly when it is needed, because that is the moment the
/// harness has just rebuilt the list from what is installed.
pub fn apply(profile: &str, profile_dir: &Path) -> Result<()> {
    let off = switched_off(profile);
    if off.is_empty() {
        return Ok(());
    }

    let path = manifest_path(profile_dir);
    let Some(mut manifest) = read(&path) else {
        return Ok(());
    };
    let Some(bundles) = manifest
        .pointer("/dsh/profile/bundles")
        .and_then(Value::as_array)
    else {
        return Ok(());
    };

    let kept: Vec<Value> = bundles
        .iter()
        .filter(|bundle| !matches!(bundle.as_str(), Some(name) if off.contains(name)))
        .cloned()
        .collect();
    if kept.len() == bundles.len() {
        return Ok(());
    }

    if let Some(slot) = manifest.pointer_mut("/dsh/profile/bundles") {
        *slot = Value::Array(kept);
    }
    write(&path, &manifest)
}

/// Put a switched-on name back in the layer list.
///
/// Appended, because that is where the harness appends: the stack is applied in
/// order, and a plugin that was last before is least surprising last again.
fn relist(profile_dir: &Path, name: &str) -> Result<()> {
    let path = manifest_path(profile_dir);
    let Some(mut manifest) = read(&path) else {
        return Ok(());
    };
    // Only something the profile actually depends on can be a layer. Anything
    // else would be a name the next reconciliation deletes, and writing it now
    // would make the panel briefly claim something untrue.
    let installed = manifest
        .pointer("/dependencies")
        .and_then(Value::as_object)
        .is_some_and(|dependencies| dependencies.contains_key(name));
    if !installed {
        return Ok(());
    }

    let Some(bundles) = manifest
        .pointer_mut("/dsh/profile/bundles")
        .and_then(Value::as_array_mut)
    else {
        return Ok(());
    };
    if bundles.iter().any(|bundle| bundle.as_str() == Some(name)) {
        return Ok(());
    }
    bundles.push(Value::from(name));

    write(&path, &manifest)
}

fn manifest_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("package.json")
}

fn read(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn write(path: &Path, manifest: &Value) -> Result<()> {
    let mut json = serde_json::to_string_pretty(manifest).map_err(|cause| {
        Error::Plugin(format!(
            "the profile manifest could not be written: {cause}"
        ))
    })?;
    json.push('\n');
    std::fs::write(path, json)
        .map_err(|cause| Error::Plugin(format!("{} could not be written: {cause}", path.display())))
}

fn remember(profile: &str, names: &BTreeSet<String>) -> Result<()> {
    let path = store();
    let mut document = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Map<String, Value>>(&raw).ok())
        .unwrap_or_default();

    let mut disabled = document
        .get("disabled")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    disabled.insert(
        profile.to_string(),
        Value::from(names.iter().cloned().collect::<Vec<String>>()),
    );
    document.insert("disabled".to_string(), Value::Object(disabled));

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|cause| {
            Error::Plugin(format!(
                "{} could not be created: {cause}",
                parent.display()
            ))
        })?;
    }
    write(&path, &Value::Object(document))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundles(manifest: &Value) -> Vec<String> {
        manifest
            .pointer("/dsh/profile/bundles")
            .and_then(Value::as_array)
            .expect("a bundle list")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    }

    /// The manifest half of `set`, without touching the user's real store.
    fn switch_off(directory: &Path, off: &[&str]) {
        let path = manifest_path(directory);
        let mut document = read(&path).expect("a manifest");
        let off: BTreeSet<String> = off.iter().map(|name| (*name).to_string()).collect();
        let kept: Vec<Value> = document
            .pointer("/dsh/profile/bundles")
            .and_then(Value::as_array)
            .expect("a bundle list")
            .iter()
            .filter(|bundle| !matches!(bundle.as_str(), Some(name) if off.contains(name)))
            .cloned()
            .collect();
        *document
            .pointer_mut("/dsh/profile/bundles")
            .expect("a bundle list") = Value::Array(kept);
        write(&path, &document).expect("written");
    }

    fn scratch(name: &str, contents: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("dsh-studio-switches-{name}"));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("a scratch profile");
        std::fs::write(manifest_path(&directory), contents).expect("a manifest");
        directory
    }

    const PROFILE: &str = r#"{
        "name": "dsh-profile-web",
        "dependencies": { "@vendor/dsh-notes": "^1.2.0", "left-pad": "^1.3.0" },
        "dsh": { "profile": { "bundles": [
            "@deepseek-ai/dsh-base",
            "@vendor/dsh-notes"
        ] } }
    }"#;

    #[test]
    fn switching_one_off_leaves_every_other_layer_alone() {
        let directory = scratch("off", PROFILE);
        switch_off(&directory, &["@vendor/dsh-notes"]);

        let after = read(&manifest_path(&directory)).expect("a manifest");
        assert_eq!(bundles(&after), ["@deepseek-ai/dsh-base"]);
        // Switched off, not uninstalled: turning it back on must not need a
        // download, so the dependency has to survive untouched.
        assert!(after.pointer("/dependencies/@vendor~1dsh-notes").is_some());
    }

    #[test]
    fn switching_one_back_on_returns_it_to_the_stack() {
        let directory = scratch("on", PROFILE);
        switch_off(&directory, &["@vendor/dsh-notes"]);

        relist(&directory, "@vendor/dsh-notes").expect("relisted");

        let after = read(&manifest_path(&directory)).expect("a manifest");
        assert_eq!(
            bundles(&after),
            ["@deepseek-ai/dsh-base", "@vendor/dsh-notes"]
        );
    }

    #[test]
    fn switching_on_twice_does_not_list_it_twice() {
        let directory = scratch("twice", PROFILE);

        relist(&directory, "@vendor/dsh-notes").expect("relisted");

        let after = read(&manifest_path(&directory)).expect("a manifest");
        assert_eq!(
            bundles(&after),
            ["@deepseek-ai/dsh-base", "@vendor/dsh-notes"],
            "a layer already in the stack is left where it is"
        );
    }

    #[test]
    fn a_name_the_profile_does_not_depend_on_is_never_listed() {
        // The next reconciliation would delete it, and until then the panel
        // would be claiming a layer that is not there.
        let directory = scratch("stranger", PROFILE);

        relist(&directory, "@vendor/not-installed").expect("nothing to do");

        let after = read(&manifest_path(&directory)).expect("a manifest");
        assert_eq!(
            bundles(&after),
            ["@deepseek-ai/dsh-base", "@vendor/dsh-notes"]
        );
    }

    #[test]
    fn a_profile_the_harness_has_not_written_yet_is_not_an_error() {
        let directory = std::env::temp_dir().join("dsh-studio-switches-absent");
        let _ = std::fs::remove_dir_all(&directory);

        assert!(apply("web", &directory).is_ok());
        assert!(relist(&directory, "@vendor/dsh-notes").is_ok());
    }

    #[test]
    fn the_manifest_keeps_the_order_the_harness_wrote_it_in() {
        // The shell edits someone else's file; reordering their keys would show
        // up as a change nobody made.
        let directory = scratch("order", PROFILE);
        relist(&directory, "left-pad").expect("relisted");

        let raw = std::fs::read_to_string(manifest_path(&directory)).expect("a manifest");
        let name = raw.find("\"name\"").expect("a name");
        let dependencies = raw.find("\"dependencies\"").expect("dependencies");
        let dsh = raw.find("\"dsh\"").expect("a dsh section");
        assert!(name < dependencies && dependencies < dsh);
    }
}

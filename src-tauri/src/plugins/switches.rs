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
//!
//! Every way into the record comes in a pair: the function the app calls, which
//! knows where the record lives, and the one under it, which is told. That is
//! what lets the chain this module exists for — switch off, install again,
//! restart, still off — be driven end to end over a scratch directory. Without
//! it the only way to exercise any of this is to write to the record belonging
//! to whoever is running the tests, which is why that chain went so long with
//! no coverage of its own.

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
    off_in(&store(), profile)
}

fn off_in(store: &Path, profile: &str) -> BTreeSet<String> {
    let Ok(raw) = std::fs::read_to_string(store) else {
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
    set_in(&store(), profile, name, enabled, profile_dir)
}

fn set_in(
    store: &Path,
    profile: &str,
    name: &str,
    enabled: bool,
    profile_dir: &Path,
) -> Result<()> {
    let mut off = off_in(store, profile);
    let changed = if enabled {
        off.remove(name)
    } else {
        off.insert(name.to_string())
    };
    if changed {
        remember_in(store, profile, &off)?;
    }

    if enabled {
        relist(profile_dir, name)
    } else {
        apply_in(store, profile, profile_dir)
    }
}

/// Make the profile's layer list agree with what the user switched off.
///
/// A no-op when nothing differs, so it is safe to call after every plugin
/// command — which is exactly when it is needed, because that is the moment the
/// harness has just rebuilt the list from what is installed.
pub fn apply(profile: &str, profile_dir: &Path) -> Result<()> {
    apply_in(&store(), profile, profile_dir)
}

fn apply_in(store: &Path, profile: &str, profile_dir: &Path) -> Result<()> {
    let off = off_in(store, profile);
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

/// Carry what was switched off in one profile over to a copy of it.
///
/// A copy that installs the same plugins but runs the ones its original does not
/// is not a copy of it, and the difference would be invisible: both manifests
/// would list the same layers.
pub fn copy(from: &str, to: &str) -> Result<()> {
    let store = store();
    let off = off_in(&store, from);
    if off.is_empty() {
        return Ok(());
    }
    remember_in(&store, to, &off)
}

/// Follow a profile that was renamed. The record is keyed by name, so without
/// this a rename would silently switch everything back on.
pub fn rename(from: &str, to: &str) -> Result<()> {
    let store = store();
    let off = off_in(&store, from);
    if !off.is_empty() {
        remember_in(&store, to, &off)?;
    }
    forget_in(&store, from)
}

/// Drop a profile's record once the profile itself is gone.
///
/// Not for tidiness: profile names get reused, and a new profile that inherited
/// a deleted one's switched-off list would start by hiding plugins nobody had
/// switched off.
pub fn forget(profile: &str) -> Result<()> {
    forget_in(&store(), profile)
}

fn forget_in(store: &Path, profile: &str) -> Result<()> {
    let mut document = document(store);
    let Some(disabled) = document.get_mut("disabled").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    if disabled.remove(profile).is_none() {
        return Ok(());
    }
    write(store, &Value::Object(document))
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
    crate::atomic::write(path, json)
        .map_err(|cause| Error::Plugin(format!("{} could not be written: {cause}", path.display())))
}

/// The record as it stands, or an empty one when there is nothing to read.
fn document(store: &Path) -> Map<String, Value> {
    std::fs::read_to_string(store)
        .ok()
        .and_then(|raw| serde_json::from_str::<Map<String, Value>>(&raw).ok())
        .unwrap_or_default()
}

/// Record the whole switched-off list for one profile, replacing what was there.
///
/// Public for the one caller that has a list without having a profile to read it
/// from: an imported profile, whose switched-off names came out of a file.
pub(crate) fn remember(profile: &str, names: &BTreeSet<String>) -> Result<()> {
    remember_in(&store(), profile, names)
}

fn remember_in(store: &Path, profile: &str, names: &BTreeSet<String>) -> Result<()> {
    let mut document = document(store);

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

    if let Some(parent) = store.parent() {
        std::fs::create_dir_all(parent).map_err(|cause| {
            Error::Plugin(format!(
                "{} could not be created: {cause}",
                parent.display()
            ))
        })?;
    }
    write(store, &Value::Object(document))
}

#[cfg(test)]
mod tests {
    use super::*;
    // The panel's own reader and lister, because the point of the chain test is
    // that a restart draws the same thing — and a restart draws it with these.
    use crate::plugins::{list, read_manifest, InstalledPlugin};

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

    fn scratch(name: &str, contents: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("dsh-studio-switches-{name}"));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("a scratch profile");
        std::fs::write(manifest_path(&directory), contents).expect("a manifest");
        directory
    }

    /// A record of this test's own, so it can write where the app writes without
    /// writing over the record belonging to whoever is running it. The directory
    /// is deliberately left absent: creating it is the app's job, and this is the
    /// only place that claim gets checked.
    fn record(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("dsh-studio-switches-{name}-record"));
        let _ = std::fs::remove_dir_all(&directory);
        directory.join("plugins.json")
    }

    /// The harness reconciling the layer list, which is the event this whole
    /// module exists to survive: after any plugin command it rebuilds the list
    /// from what is installed, and a name the user switched off comes straight
    /// back with the rest.
    fn reconcile(directory: &Path, layers: &[&str]) {
        let path = manifest_path(directory);
        let mut document = read(&path).expect("a manifest");
        *document
            .pointer_mut("/dsh/profile/bundles")
            .expect("a bundle list") =
            Value::Array(layers.iter().map(|name| Value::from(*name)).collect());
        write(&path, &document).expect("written");
    }

    /// What the panel would draw for one plugin, read back off disk the way a
    /// fresh start reads it.
    fn after_restart(store: &Path, profile: &str, directory: &Path, name: &str) -> InstalledPlugin {
        let manifest = read_manifest(directory).expect("a manifest");
        list(&manifest, &off_in(store, profile))
            .into_iter()
            .find(|plugin| plugin.name == name)
            .expect("an installed plugin is listed whether or not it is running")
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
        set_in(
            &record("off"),
            "web",
            "@vendor/dsh-notes",
            false,
            &directory,
        )
        .expect("switched off");

        let after = read(&manifest_path(&directory)).expect("a manifest");
        assert_eq!(bundles(&after), ["@deepseek-ai/dsh-base"]);
        // Switched off, not uninstalled: turning it back on must not need a
        // download, so the dependency has to survive untouched.
        assert!(after.pointer("/dependencies/@vendor~1dsh-notes").is_some());
    }

    #[test]
    fn switching_one_back_on_returns_it_to_the_stack() {
        let directory = scratch("on", PROFILE);
        set_in(&record("on"), "web", "@vendor/dsh-notes", false, &directory).expect("switched off");

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

        assert!(apply_in(&record("absent"), "web", &directory).is_ok());
        assert!(relist(&directory, "@vendor/dsh-notes").is_ok());
    }

    /// Install, switch off, install again, restart — still off.
    ///
    /// The four steps are one test rather than four because it is the seam
    /// between them that has broken before, never a step on its own: switching
    /// off worked, and the next install put the plugin back. Splitting them up
    /// would leave every part passing and the thing the user reported unproven.
    #[test]
    fn a_plugin_switched_off_stays_off_across_an_install_and_a_restart() {
        const PLUGIN: &str = "@vendor/dsh-notes";
        const STACK: [&str; 2] = ["@deepseek-ai/dsh-base", "@vendor/dsh-notes"];
        let directory = scratch("chain", PROFILE);
        let store = record("chain");
        let layers = || bundles(&read(&manifest_path(&directory)).expect("a manifest"));

        // Installed and running, which is what the harness leaves behind. The
        // shell has nothing to re-assert yet and must not touch the manifest.
        apply_in(&store, "web", &directory).expect("nothing is switched off yet");
        assert_eq!(layers(), STACK);

        // Switched off in the panel: out of the stack, and written down.
        set_in(&store, "web", PLUGIN, false, &directory).expect("switched off");
        assert_eq!(layers(), ["@deepseek-ai/dsh-base"]);
        assert!(off_in(&store, "web").contains(PLUGIN));

        // Anything at all is installed, so the harness rebuilds the stack from
        // what is on disk and hands back the plugin the user just switched off.
        reconcile(&directory, &STACK);
        assert_eq!(
            layers(),
            STACK,
            "the harness does not know it was switched off"
        );
        apply_in(&store, "web", &directory).expect("re-asserted after the install");
        assert_eq!(layers(), ["@deepseek-ai/dsh-base"]);

        // Restarted. Nothing is in memory any more, and the panel has to say
        // what it said before: switched off, and still there to switch back on.
        let listed = after_restart(&store, "web", &directory, PLUGIN);
        assert!(listed.disabled && !listed.active);
        assert_eq!(listed.spec, "^1.2.0", "switched off is not uninstalled");

        // And back on, leaving no trace in the record to re-assert later.
        set_in(&store, "web", PLUGIN, true, &directory).expect("switched on");
        assert_eq!(layers(), STACK);
        assert!(off_in(&store, "web").is_empty());
        assert!(!after_restart(&store, "web", &directory, PLUGIN).disabled);
    }

    #[test]
    fn one_profile_forgetting_its_list_leaves_every_other_profile_alone() {
        // The record holds every profile, so deleting one profile reaches into
        // the same file the others are read from.
        let store = record("shared");
        let off = |name: &str| BTreeSet::from([name.to_string()]);
        remember_in(&store, "web", &off("@vendor/dsh-notes")).expect("recorded");
        remember_in(&store, "api", &off("@vendor/dsh-charts")).expect("recorded");

        forget_in(&store, "web").expect("forgotten");

        assert!(off_in(&store, "web").is_empty());
        assert_eq!(off_in(&store, "api"), off("@vendor/dsh-charts"));
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

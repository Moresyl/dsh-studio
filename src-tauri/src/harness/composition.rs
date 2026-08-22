//! Validate the fully composed Harness profile before any plugin is booted.
//!
//! A package can install successfully and still be impossible to boot when two
//! patch layers register the same loader entry id. The Harness launcher already
//! owns the exact composition rules, so Studio asks it for `--dump-config`
//! rather than maintaining a second implementation. Only an active, installed
//! third-party bundle may be disabled automatically; core and user patch
//! conflicts fail closed with the owners named.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;

use super::supervisor::LaunchPlan;
use crate::error::{Error, Result};
use crate::paths;

const DUMP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_AUTOMATIC_REPAIRS: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Duplicate {
    id: String,
    owners: Vec<String>,
}

/// Compose the exact launch and remove only third-party bundles that make the
/// loader tree invalid. The returned notices belong in the visible startup log.
pub async fn preflight(plan: &LaunchPlan) -> Result<Vec<String>> {
    let mut notices = Vec::new();

    for _ in 0..=MAX_AUTOMATIC_REPAIRS {
        let dump = dump(plan).await?;
        let duplicates = duplicate_entry_ids(&dump);
        if duplicates.is_empty() {
            return Ok(notices);
        }

        let profile_dir = paths::profile_dir(&plan.profile);
        let manifest = crate::plugins::read_manifest(&profile_dir).ok_or_else(|| {
            Error::Profile(format!(
                "{} has an invalid profile manifest",
                profile_dir.display()
            ))
        })?;
        let Some(plugin) = conflicting_third_party(&duplicates, &manifest) else {
            return Err(conflict_error(&duplicates));
        };

        crate::plugins::switches::set(&plan.profile, &plugin, false, &profile_dir)?;
        let ids = duplicates
            .iter()
            .filter(|duplicate| duplicate.owners.iter().any(|owner| owner == &plugin))
            .map(|duplicate| duplicate.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        notices.push(format!(
            "disabled incompatible third-party plugin {plugin} before startup: duplicate loader entry id(s): {ids}"
        ));
    }

    Err(Error::Plugin(format!(
        "the profile still has loader entry conflicts after {MAX_AUTOMATIC_REPAIRS} safe repairs"
    )))
}

async fn dump(plan: &LaunchPlan) -> Result<String> {
    let mut command = plan.dump_command();
    command.kill_on_drop(true);
    let output = tokio::time::timeout(DUMP_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            Error::Plugin(format!(
                "profile composition did not finish within {}s",
                DUMP_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|cause| Error::Plugin(format!("profile composition could not start: {cause}")))?;

    if !output.status.success() {
        let detail = concise(&String::from_utf8_lossy(&output.stderr));
        return Err(Error::Plugin(format!(
            "profile composition failed before startup: {detail}"
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn concise(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return "the Harness launcher returned no diagnostic".into();
    }
    text.chars().take(2_000).collect()
}

/// `--dump-config` keeps a provenance comment before every run of entries. The
/// top-level rows are the loader's actual entry group; nested `id` properties
/// belong to plugin configuration and must not be counted as loader entries.
fn duplicate_entry_ids(dump: &str) -> Vec<Duplicate> {
    let mut owner = "unknown layer".to_string();
    let mut seen: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for line in dump.lines() {
        if let Some(label) = line.strip_prefix("# == ") {
            // Keep patch provenance intact. A row changed by a user or runtime
            // overlay is not equivalent to the bundle it originally came
            // from, and must therefore fail closed instead of making that
            // bundle eligible for automatic disablement.
            owner = label.trim().to_string();
            continue;
        }
        let Some(id) = line.strip_prefix("- id: ") else {
            continue;
        };
        let id = id
            .split(" #")
            .next()
            .unwrap_or(id)
            .trim()
            .trim_matches(['\'', '"'])
            .to_string();
        if !id.is_empty() {
            seen.entry(id).or_default().push(owner.clone());
        }
    }

    seen.into_iter()
        .filter_map(|(id, owners)| (owners.len() > 1).then_some(Duplicate { id, owners }))
        .collect()
}

/// Pick the later conflicting owner only when the profile proves it is both an
/// installed dependency and an active bundle. That excludes core layers,
/// runtime overlays, user patches and stale provenance labels.
fn conflicting_third_party(duplicates: &[Duplicate], manifest: &Value) -> Option<String> {
    let dependencies = manifest.pointer("/dependencies")?.as_object()?;
    let bundles = manifest.pointer("/dsh/profile/bundles")?.as_array()?;

    duplicates.iter().find_map(|duplicate| {
        duplicate.owners.iter().rev().find_map(|owner| {
            let active = bundles.iter().any(|bundle| bundle.as_str() == Some(owner));
            (active
                && dependencies.contains_key(owner)
                && !owner.starts_with("@deepseek-ai/")
                && owner != "@moresyl/dsh-studio-integration")
                .then(|| owner.clone())
        })
    })
}

fn conflict_error(duplicates: &[Duplicate]) -> Error {
    let conflicts = duplicates
        .iter()
        .map(|duplicate| format!("{} ({})", duplicate.id, duplicate.owners.join(" vs ")))
        .collect::<Vec<_>>()
        .join(", ");
    Error::Plugin(format!(
        "the profile cannot start because loader entry ids are duplicated: {conflicts}; disable or update the named conflicting plugin"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DUPLICATE_DUMP: &str = r#"# == @deepseek-ai/dsh-web-app
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'
- id: stable
  config:
    - id: nested-configuration-id
# == dsh-code
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-worker-thread'
# == dsh-code, patched by a-user-patch
- id: session-reference
# == @deepseek-ai/dsh-web-app
- id: session-reference
"#;

    fn manifest(bundles: &[&str], dependencies: &[&str]) -> Value {
        serde_json::json!({
            "dependencies": dependencies
                .iter()
                .map(|name| ((*name).to_string(), Value::from("1.0.0")))
                .collect::<serde_json::Map<_, _>>(),
            "dsh": { "profile": { "bundles": bundles } }
        })
    }

    #[test]
    fn dump_parser_reports_top_level_duplicates_with_their_owners() {
        assert_eq!(
            duplicate_entry_ids(DUPLICATE_DUMP),
            vec![
                Duplicate {
                    id: "code-runtime".into(),
                    owners: vec!["@deepseek-ai/dsh-web-app".into(), "dsh-code".into()],
                },
                Duplicate {
                    id: "session-reference".into(),
                    owners: vec![
                        "dsh-code, patched by a-user-patch".into(),
                        "@deepseek-ai/dsh-web-app".into(),
                    ],
                },
            ]
        );
    }

    #[test]
    fn only_an_active_installed_third_party_bundle_is_repairable() {
        let duplicates = duplicate_entry_ids(DUPLICATE_DUMP);
        let active = manifest(&["@deepseek-ai/dsh-web-app", "dsh-code"], &["dsh-code"]);
        assert_eq!(
            conflicting_third_party(&duplicates, &active).as_deref(),
            Some("dsh-code")
        );

        let inactive = manifest(&["@deepseek-ai/dsh-web-app"], &["dsh-code"]);
        assert_eq!(conflicting_third_party(&duplicates, &inactive), None);
    }

    #[test]
    fn core_and_runtime_owned_layers_are_never_automatically_disabled() {
        let duplicates = vec![Duplicate {
            id: "same".into(),
            owners: vec![
                "@deepseek-ai/dsh-base".into(),
                "@moresyl/dsh-studio-integration".into(),
            ],
        }];
        let document = manifest(
            &["@deepseek-ai/dsh-base", "@moresyl/dsh-studio-integration"],
            &["@deepseek-ai/dsh-base", "@moresyl/dsh-studio-integration"],
        );
        assert_eq!(conflicting_third_party(&duplicates, &document), None);
    }

    #[test]
    fn a_user_patch_cannot_be_mistaken_for_its_third_party_base_layer() {
        let duplicates = vec![Duplicate {
            id: "same".into(),
            owners: vec![
                "@deepseek-ai/dsh-base".into(),
                "dsh-code, patched by a-user-patch".into(),
            ],
        }];
        let document = manifest(&["@deepseek-ai/dsh-base", "dsh-code"], &["dsh-code"]);
        assert_eq!(conflicting_third_party(&duplicates, &document), None);
    }

    #[test]
    fn a_unique_dump_needs_no_repair() {
        assert!(duplicate_entry_ids("# == one\n- id: first\n# == two\n- id: second\n").is_empty());
    }

    /// End-to-end acceptance against the locally installed qualified runtime
    /// and selected profile. It is opt-in because it safely updates that real
    /// profile's compatibility switches and boots a service process.
    #[tokio::test]
    #[ignore = "uses the installed Harness and selected user profile"]
    async fn installed_profile_announces_a_port_after_safe_conflict_repair() {
        let plan = crate::harness::launch_plan().expect("a runnable local launch plan");
        let notices = preflight(&plan).await.expect("a valid composed profile");
        for notice in &notices {
            eprintln!("{notice}");
        }

        let supervisor = crate::harness::supervisor::Supervisor::new().expect("a supervisor");
        let origin = std::sync::Arc::clone(&supervisor)
            .start(plan)
            .await
            .expect("the Harness announces a port");
        crate::harness::health::probe(&origin, Duration::from_secs(5))
            .await
            .expect("the announced origin answers HTTP");
        assert!(
            supervisor.recent_log().iter().all(|(_, line)| {
                !line.contains("opening the default browser")
                    && !line.contains("pass --no-open to disable")
            }),
            "the Studio-owned Harness must never hand off to an external browser"
        );
        eprintln!("verified local Harness readiness at {origin}");
        supervisor.stop().await;
    }
}

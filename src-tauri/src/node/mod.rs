//! Put a Node runtime on a machine that has none.
//!
//! The harness is a Node program, so before this shell can do anything at all
//! the machine needs a Node. Asking for one is the honest answer for a developer
//! tool and the wrong one for an application someone downloaded: "install this
//! other thing first, from a different website, then come back" is where most
//! people stop. So the shell installs one itself, into its own data directory,
//! where it belongs to the shell and not to the user's `PATH`.
//!
//! Three things make that defensible rather than presumptuous:
//!
//! - It is opt-in. Nothing here runs until someone presses the button on the row
//!   that says Node is missing.
//! - It is contained. The runtime goes under application data, one directory per
//!   release, and nothing outside this application is changed — no `PATH`, no
//!   registry, no `/usr/local`. Deleting the directory undoes it.
//! - It is verified. The archive is checked against the SHA-256 the release
//!   channel publishes before a single file is unpacked, and the unpacked runtime
//!   has to answer `--version` before it is reported as installed.
//!
//! A Node the user installed themselves always still wins a tie — see
//! `Source::rank` in the detection crate.

pub mod commands;

pub(crate) mod archive;
mod catalog;
mod http;

pub(crate) use http::ensure_crypto_provider;

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use node_runtime::{NodeInstallation, Source};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::paths;

/// Partially downloaded archive. One fixed name, inside the managed store: a
/// name per attempt would leave the store littered with the ones that failed.
const DOWNLOAD_NAME: &str = ".download";

/// Where an archive is expanded before it is given its version's name. Nothing
/// under this name is ever reported as a runtime, which is the point — a release
/// directory only exists once it is complete.
const STAGING_NAME: &str = ".staging";

/// Bytes between progress reports.
///
/// Every chunk would be a few thousand IPC messages for one download, and the
/// window cannot draw them; 512 KiB is about sixty updates over a Windows zip,
/// which is a bar that visibly moves without a flood behind it.
const PROGRESS_STEP: u64 = 512 * 1024;

/// Guard so two clicks cannot run two downloads into one directory.
#[derive(Debug, Default)]
pub struct NodeJobs {
    pub busy: AtomicBool,
}

#[derive(Debug, Deserialize, Serialize)]
struct Selection {
    path: PathBuf,
}

/// Pick the remembered runtime when it is still present and supported. A
/// missing selection is intentionally non-fatal: version managers can remove
/// an install outside Studio, so the newest supported runtime remains a safe
/// fallback instead of making the harness unstartable.
pub fn selected(runtimes: &[NodeInstallation]) -> Option<NodeInstallation> {
    let remembered = std::fs::read(paths::node_selection_file())
        .ok()
        .and_then(|body| serde_json::from_slice::<Selection>(&body).ok())
        .map(|selection| selection.path);
    pick(runtimes, remembered.as_deref())
}

/// Pure selection rule, kept separate so it can be tested without touching the
/// user's application-data directory.
pub fn pick(runtimes: &[NodeInstallation], remembered: Option<&Path>) -> Option<NodeInstallation> {
    remembered
        .and_then(|path| {
            runtimes
                .iter()
                .find(|runtime| {
                    runtime.version >= node_runtime::MINIMUM_SUPPORTED && runtime.path == path
                })
                .cloned()
        })
        .or_else(|| {
            runtimes
                .iter()
                .find(|runtime| runtime.version >= node_runtime::MINIMUM_SUPPORTED)
                .cloned()
        })
}

/// Validate and persist a user-selected runtime. Only an executable discovered
/// by the same scanner used for launch may be selected; a typed path can never
/// smuggle an arbitrary binary into the harness environment.
pub fn choose(path: PathBuf) -> Result<NodeInstallation> {
    let resolved = node_runtime::plain_path(path.canonicalize().map_err(|cause| {
        Error::NodeSelection(format!("{} could not be opened: {cause}", path.display()))
    })?);
    let runtimes = node_runtime::discover_in(Some(&paths::managed_node_dir()));
    let runtime = runtimes
        .into_iter()
        .find(|runtime| {
            runtime.path == resolved && runtime.version >= node_runtime::MINIMUM_SUPPORTED
        })
        .ok_or_else(|| {
            Error::NodeSelection(format!(
                "{} is not a supported Node.js runtime discovered on this machine",
                resolved.display()
            ))
        })?;

    let file = paths::node_selection_file();
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|cause| {
            Error::NodeSelection(format!(
                "{} could not be created: {cause}",
                parent.display()
            ))
        })?;
    }
    let mut body = serde_json::to_vec_pretty(&Selection {
        path: runtime.path.clone(),
    })
    .map_err(|cause| Error::NodeSelection(format!("selection is invalid: {cause}")))?;
    body.push(b'\n');
    let temporary = file.with_extension("dsh-studio.tmp");
    std::fs::write(&temporary, body).map_err(|cause| {
        Error::NodeSelection(format!(
            "{} could not be written: {cause}",
            temporary.display()
        ))
    })?;
    if file.exists() {
        std::fs::remove_file(&file).map_err(|cause| {
            Error::NodeSelection(format!("{} could not be replaced: {cause}", file.display()))
        })?;
    }
    std::fs::rename(&temporary, &file).map_err(|cause| {
        Error::NodeSelection(format!(
            "{} could not be committed: {cause}",
            file.display()
        ))
    })?;
    Ok(runtime)
}

/// How far along an install is.
///
/// Deliberately more than a percentage. A first-run download that says nothing
/// but "23%" leaves the two questions people actually have unanswered — what is
/// being installed, and where it is coming from — and those are exactly the
/// questions a shell that downloads a runtime on someone's behalf owes an answer
/// to.
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Progress {
    /// Asking the mirrors which release is current.
    Resolving,
    /// A release was chosen. The one event carrying the URL, so the log records
    /// which mirror answered — the first thing worth knowing when a download was
    /// slow or failed.
    Chosen {
        version: String,
        url: String,
    },
    /// Everything from here on repeats the version rather than expecting whoever
    /// draws it to have remembered `Chosen`. Events are delivered over a channel
    /// that is allowed to drop them under load, so a report that only makes sense
    /// after its predecessor is a report that eventually names the wrong release.
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    /// Comparing what arrived against the published checksum.
    Verifying {
        version: String,
    },
    Extracting {
        version: String,
    },
    Installed {
        version: String,
    },
}

impl Progress {
    /// The line this belongs on in the application log, if any.
    ///
    /// Byte counts are not one: they belong on a progress bar, and putting sixty
    /// of them into a 2000-line ring would push out the harness output someone
    /// is keeping the log open to read.
    pub fn note(&self) -> Option<String> {
        match self {
            Progress::Resolving => Some("looking for the newest Node.js LTS release".into()),
            Progress::Chosen { version, url } => {
                Some(format!("downloading Node {version} from {url}"))
            }
            Progress::Downloading { .. } => None,
            Progress::Verifying { .. } => {
                Some("checking the download against its published checksum".into())
            }
            Progress::Extracting { version } => Some(format!("unpacking Node {version}")),
            Progress::Installed { version } => Some(format!("Node {version} is installed")),
        }
    }
}

/// Download and install a Node runtime into the application's own store.
pub async fn provision<R>(report: R) -> Result<NodeInstallation>
where
    R: Fn(Progress),
{
    provision_into(&paths::managed_node_dir(), report).await
}

/// Install the runtime carried by a Full package without touching the network.
pub async fn provision_bundled<R>(
    artifact: crate::offline::Artifact,
    report: R,
) -> Result<NodeInstallation>
where
    R: Fn(Progress) + Send + 'static,
{
    let root = paths::managed_node_dir();
    let destination = root.join(&artifact.version);
    if let Some(installed) = installation_at(&destination) {
        report(Progress::Installed {
            version: artifact.version,
        });
        return Ok(installed);
    }

    report(Progress::Chosen {
        version: artifact.version.clone(),
        url: "bundled://dsh-studio-full/node".into(),
    });
    report(Progress::Verifying {
        version: artifact.version.clone(),
    });
    let version = artifact.version.clone();
    report(Progress::Extracting {
        version: version.clone(),
    });

    let installed = tokio::task::spawn_blocking(move || {
        crate::offline::verify(&artifact)
            .map_err(|cause| Error::NodeProvision(cause.to_string()))?;
        std::fs::create_dir_all(&root).map_err(|cause| {
            Error::NodeProvision(format!(
                "the runtime directory could not be created: {cause}"
            ))
        })?;
        let staging = root.join(".offline-staging");
        let _ = std::fs::remove_dir_all(&staging);
        let unpacked = archive::unpack(&artifact.file, &staging)?;
        let _ = std::fs::remove_dir_all(&destination);
        std::fs::rename(&unpacked, &destination).map_err(|cause| {
            Error::NodeProvision(format!(
                "the bundled runtime could not be activated: {cause}"
            ))
        })?;
        let _ = std::fs::remove_dir_all(&staging);
        installation_at(&destination).ok_or_else(|| {
            let _ = std::fs::remove_dir_all(&destination);
            Error::NodeProvision(
                "the bundled Node runtime was verified but will not run on this system".into(),
            )
        })
    })
    .await
    .map_err(|cause| {
        Error::NodeProvision(format!(
            "installing the bundled runtime did not finish: {cause}"
        ))
    })??;

    report(Progress::Installed { version });
    Ok(installed)
}

/// The same, into a caller-chosen store. Separate so it can be tested somewhere
/// other than the real application data directory.
pub async fn provision_into<R>(root: &Path, report: R) -> Result<NodeInstallation>
where
    R: Fn(Progress),
{
    let client = http::client()?;

    report(Progress::Resolving);
    let release = catalog::newest_lts(&client).await?;
    let destination = root.join(&release.version);

    // Already here and working. An interrupted first run should not mean another
    // 30 MB, and neither should a second click while the first one is still
    // being noticed.
    if let Some(installed) = installation_at(&destination) {
        report(Progress::Installed {
            version: release.version,
        });
        return Ok(installed);
    }

    report(Progress::Chosen {
        version: release.version.clone(),
        url: release.url.clone(),
    });

    std::fs::create_dir_all(root).map_err(|cause| {
        Error::NodeProvision(format!(
            "the runtime directory could not be created: {cause}"
        ))
    })?;
    let download = root.join(DOWNLOAD_NAME);
    let staging = root.join(STAGING_NAME);
    // Whatever a previous attempt left is not what this one verified.
    discard(&download, &staging);

    let mut reported: u64 = 0;
    let digest = http::download(&client, &release.url, &download, |received, total| {
        let finished = total.is_some_and(|total| received >= total);
        if received - reported >= PROGRESS_STEP || received == 0 || finished {
            reported = received;
            report(Progress::Downloading {
                version: release.version.clone(),
                received,
                total,
            });
        }
    })
    .await?;

    report(Progress::Verifying {
        version: release.version.clone(),
    });
    if !digest.eq_ignore_ascii_case(&release.sha256) {
        // Thrown away rather than kept for inspection: whatever this is, it is
        // not the release it claims to be, and the next attempt must not find it
        // sitting there looking like a resumable download.
        discard(&download, &staging);
        return Err(Error::NodeProvision(format!(
            "{} does not match the checksum published for it, so it was discarded",
            release.archive
        )));
    }

    report(Progress::Extracting {
        version: release.version.clone(),
    });
    let unpacked = {
        let download = download.clone();
        let staging = staging.clone();
        // Expanding ~50 MB of small files is seconds of blocking work, and the
        // thread it would block is the one delivering the events above.
        tokio::task::spawn_blocking(move || archive::unpack(&download, &staging))
            .await
            .map_err(|cause| {
                Error::NodeProvision(format!("unpacking the runtime did not finish: {cause}"))
            })??
    };

    // The release becomes visible under its version's name only now that it is
    // whole — which is what makes an interrupted install leave nothing behind
    // that the scanner would report as a runtime.
    let _ = std::fs::remove_dir_all(&destination);
    std::fs::rename(&unpacked, &destination).map_err(|cause| {
        Error::NodeProvision(format!(
            "the runtime could not be moved into place: {cause}"
        ))
    })?;
    discard(&download, &staging);

    match installation_at(&destination) {
        Some(installed) => {
            report(Progress::Installed {
                version: release.version,
            });
            Ok(installed)
        }
        None => {
            // A build for the right operating system and architecture that still
            // will not run. A Linux built against musl rather than glibc is the
            // usual reason, and there is nothing to fix from here — but reporting
            // it now is much better than leaving a runtime on disk that fails
            // whenever the harness is next started.
            let _ = std::fs::remove_dir_all(&destination);
            Err(Error::NodeProvision(format!(
                "Node {} unpacked but will not run on this system",
                release.version
            )))
        }
    }
}

/// Read a release directory back as a runtime, if it holds a working one.
fn installation_at(release_dir: &Path) -> Option<NodeInstallation> {
    let executable = node_runtime::release_executable(release_dir);
    let version = node_runtime::probe(&executable)?;

    Some(NodeInstallation {
        // The same spelling the scanner will report for this file, so the
        // installation handed back here and the one found on the next scan are
        // recognisably the same install.
        path: node_runtime::plain_path(executable.canonicalize().unwrap_or(executable)),
        version,
        source: Source::Managed,
    })
}

/// Remove the scratch a download leaves, ignoring what was not there.
fn discard(download: &Path, staging: &Path) {
    let _ = std::fs::remove_file(download);
    let _ = std::fs::remove_dir_all(staging);
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use node_runtime::{NodeInstallation, Source, Version};

    use super::{pick, Progress, PROGRESS_STEP};

    fn runtime(path: &str, version: Version) -> NodeInstallation {
        NodeInstallation {
            path: PathBuf::from(path),
            version,
            source: Source::System,
        }
    }

    #[test]
    fn remembered_supported_runtime_wins_over_newest_default() {
        let runtimes = vec![
            runtime("/node/24", Version::new(24, 0, 0)),
            runtime("/node/22", Version::new(22, 19, 0)),
        ];
        assert_eq!(
            pick(&runtimes, Some(PathBuf::from("/node/22").as_path()))
                .unwrap()
                .path,
            PathBuf::from("/node/22")
        );
    }

    #[test]
    fn missing_or_too_old_selection_falls_back_to_newest_supported() {
        let runtimes = vec![
            runtime("/node/24", Version::new(24, 0, 0)),
            runtime("/node/20", Version::new(20, 19, 0)),
        ];
        assert_eq!(
            pick(&runtimes, Some(PathBuf::from("/node/missing").as_path()))
                .unwrap()
                .path,
            PathBuf::from("/node/24")
        );
        assert_eq!(
            pick(&runtimes, Some(PathBuf::from("/node/20").as_path()))
                .unwrap()
                .path,
            PathBuf::from("/node/24")
        );
    }

    #[test]
    fn keeps_byte_counts_out_of_the_log_and_everything_else_in() {
        assert!(
            Progress::Downloading {
                version: "v24.19.0".into(),
                received: PROGRESS_STEP,
                total: None
            }
            .note()
            .is_none(),
            "sixty byte counts would push the harness output out of the log ring"
        );

        let chosen = Progress::Chosen {
            version: "v24.19.0".into(),
            url: "https://cdn.npmmirror.com/binaries/node/v24.19.0/x.zip".into(),
        };
        let line = chosen.note().expect("the mirror belongs in the log");
        assert!(
            line.contains("cdn.npmmirror.com"),
            "which mirror answered is the first thing a slow download raises"
        );
    }

    /// The whole chain against the live release channel: resolve, download,
    /// verify, unpack, and run what came out.
    ///
    /// Ignored, so `cargo test` stays offline and quick — but kept, because the
    /// parts this covers are the ones that cannot be checked any other way. The
    /// archive layout, the checksum document's format and the mirror's routing
    /// are all facts about somebody else's server, and a unit test can only
    /// assert what this file already believes about them. Run it with
    /// `cargo test -p dsh-studio -- --ignored --nocapture` after touching the
    /// catalog or the extractor.
    #[tokio::test]
    #[ignore = "downloads a Node release from the internet"]
    async fn brings_down_a_runtime_that_carries_its_own_npm() {
        let root = std::env::temp_dir().join("dsh-studio-provision-check");
        let _ = std::fs::remove_dir_all(&root);

        let installed = super::provision_into(&root, |progress| {
            if let Some(line) = progress.note() {
                eprintln!("{line}");
            }
        })
        .await
        .expect("a Node release built for this machine");

        assert!(installed.version >= node_runtime::MINIMUM_SUPPORTED);
        // The harness is installed by running npm out of the chosen runtime, so a
        // runtime without npm beside it would provision cleanly and then fail at
        // the next step for reasons pointing nowhere near here.
        assert!(
            crate::harness::install::npm_cli(&installed.path).is_some(),
            "no npm alongside {}",
            installed.path.display()
        );

        std::fs::remove_dir_all(&root).expect("removing the directory this test made");
    }
}

//! Reviewed application releases and the process-wide installation boundary.

mod catalog;
mod intents;
mod policy;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::watch;

pub use intents::UpdateState;

use crate::error::Result;
use crate::node::http;

use catalog::{failure, Direction};
use policy::{Candidate, Offer, MAX_DOWNLOAD_BYTES};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseReview {
    pub review_id: String,
    pub fingerprint: String,
    pub version: String,
    pub current_version: String,
    pub notes: String,
    pub published: String,
    pub url: String,
    pub artifact: String,
    pub bytes: u64,
    pub direction: Direction,
    pub can_install: bool,
    pub install_block: Option<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub downloaded: u64,
    pub total: u64,
}

#[tauri::command]
pub async fn application_versions(app: AppHandle, page: u32) -> Result<catalog::ReleasePage> {
    catalog::list(page, &app.package_info().version).await
}

#[tauri::command]
pub async fn application_update_review(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    version: Option<String>,
) -> Result<Option<ReleaseReview>> {
    let Some((_, candidate)) = checked_candidate(&app, version.as_deref()).await? else {
        return Ok(None);
    };
    let parsed = catalog::stable_version(&candidate.version)?;
    let current = &app.package_info().version;
    let direction = match parsed.cmp(current) {
        std::cmp::Ordering::Less => Direction::Older,
        std::cmp::Ordering::Equal => Direction::Current,
        std::cmp::Ordering::Greater => Direction::Newer,
    };
    let review_id = state.remember(window.label(), candidate.clone())?;
    let install_block = policy::install_block(&candidate, current, cfg!(debug_assertions))?;
    Ok(Some(ReleaseReview {
        review_id,
        fingerprint: candidate.fingerprint()?,
        url: catalog::release_url(&candidate.version),
        version: candidate.version,
        current_version: current.to_string(),
        notes: candidate.notes,
        published: candidate.published,
        artifact: candidate.artifact,
        bytes: candidate.bytes,
        direction,
        can_install: install_block.is_none(),
        install_block,
    }))
}

#[tauri::command]
pub fn application_update_discard(
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    review_id: String,
) -> Result<()> {
    state.discard(window.label(), &review_id)
}

#[tauri::command]
pub fn application_update_cancel(
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    review_id: String,
) -> Result<bool> {
    state.cancel(window.label(), &review_id)
}

#[tauri::command]
pub async fn application_update_install(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateState>,
    review_id: String,
    progress: Channel<Progress>,
) -> Result<()> {
    let lifecycle = crate::lifecycle::acquire(&app).await?;
    if cfg!(debug_assertions) {
        return Err(failure(
            "application installation is disabled in development builds",
        ));
    }
    let (reviewed, mut job) = state.claim(window.label(), &review_id)?;
    if policy::install_block(&reviewed, &app.package_info().version, false)?.is_some() {
        return Err(failure(
            "RPM application downgrades require the system package manager",
        ));
    }
    let mut cancellation = job.cancellation();
    let report = |phase, downloaded| {
        progress
            .send(Progress {
                phase,
                downloaded,
                total: reviewed.bytes,
            })
            .map_err(|_| failure("the update window closed; installation was cancelled"))
    };
    report("checking", 0)?;
    let prepare = async {
        let (update, candidate) = checked_candidate(&app, Some(&reviewed.version))
            .await?
            .ok_or_else(|| failure("the reviewed application release is no longer available"))?;
        policy::unchanged(&reviewed, &candidate)?;
        report("downloading", 0)?;
        let bytes = verified_download(&update, &candidate, |phase, downloaded| {
            report(phase, downloaded)
        })
        .await?;
        Ok::<_, crate::error::Error>((update, bytes))
    };
    let (update, bytes) = tokio::select! {
        biased;
        _ = cancelled(&mut cancellation) => return Err(failure("application update cancelled")),
        result = prepare => result?,
    };

    // Acquire every existing mutation gate before stopping any user process.
    // A failed download or a busy runtime therefore leaves the session running.
    let runtime = app.state::<crate::harness::commands::AppState>();
    let _lifecycle = runtime.application_update_gate()?;
    let plugin_jobs = app.state::<Arc<crate::plugins::PluginJobs>>();
    let _plugins = plugin_jobs.claim()?;
    let node_jobs = app.state::<Arc<crate::node::NodeJobs>>();
    let _nodes = node_jobs.claim()?;
    job.commit()?;
    report("installing", reviewed.bytes)?;
    runtime.supervisor.stop().await;
    runtime.supervisor.wait_until_inactive().await?;
    let terminals = app.state::<Arc<crate::terminal::Terminals>>();
    for terminal in terminals.list() {
        if let Err(cause) = terminals.close(&terminal.id) {
            if terminals.list().iter().any(|live| live.id == terminal.id) {
                return Err(cause);
            }
        }
    }
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|_| failure("application installer could not finish"))?
        .map_err(|cause| failure(format!("application installer failed: {cause}")))?;
    job.installed();
    lifecycle.commit();
    app.restart();
}

async fn checked_candidate<R: Runtime>(
    app: &AppHandle<R>,
    version: Option<&str>,
) -> Result<Option<(Update, Candidate)>> {
    // Bound the entire review, including catalog and signature requests.
    tokio::time::timeout(CHECK_TIMEOUT, fetch_candidate(app, version))
        .await
        .map_err(|_| {
            failure("application update check timed out; retry or check the Releases page")
        })?
}

async fn fetch_candidate<R: Runtime>(
    app: &AppHandle<R>,
    version: Option<&str>,
) -> Result<Option<(Update, Candidate)>> {
    let mut builder = app
        .updater_builder()
        .timeout(Duration::from_secs(12))
        .configure_client(|client| {
            client.connect_timeout(Duration::from_secs(15)).redirect(
                reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 5 || attempt.url().scheme() != "https" {
                        attempt.error("application updates require bounded HTTPS redirects")
                    } else {
                        attempt.follow()
                    }
                }),
            )
        });
    if let Some(version) = version {
        let endpoint = policy::asset_url(version, "latest.json")?;
        builder = builder
            .endpoints(vec![
                url::Url::parse(&endpoint)
                    .map_err(|_| failure("invalid application release endpoint"))?,
                url::Url::parse(&format!(
                    "{}/versions/v{version}.latest.json",
                    catalog::WEBSITE
                ))
                .map_err(|_| failure("invalid application release fallback"))?,
            ])
            .map_err(|cause| failure(format!("application update endpoint is invalid: {cause}")))?
            .version_comparator(|_, _| true);
    }
    let updater = builder
        .build()
        .map_err(|cause| failure(format!("application updater could not start: {cause}")))?;
    let update = tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| {
            failure("application update check timed out; retry or check the Releases page")
        })?
        .map_err(|cause| {
            failure(format!(
                "application update feed could not be read: {cause}"
            ))
        })?;
    let Some(mut update) = update else {
        return Ok(None);
    };
    if version.is_some_and(|version| version != update.version) {
        return Err(failure(
            "application update feed does not match the selected version",
        ));
    }
    let published = catalog::published(&update.version).await?;
    let candidate = policy::bind(
        Offer {
            version: &update.version,
            notes: update.body.as_deref().unwrap_or_default(),
            download_url: update.download_url.as_str(),
            signature: &update.signature,
        },
        &published,
        std::env::consts::OS,
    )?;
    let signature = http::text(
        &http::client()?,
        &policy::asset_url(&candidate.version, &format!("{}.sig", candidate.artifact))?,
    )
    .await?;
    if signature.trim() != candidate.signature {
        return Err(failure(
            "application updater signature differs from the published artifact",
        ));
    }
    // The release asset API can be rate-limited even when its public CDN works.
    // Admission above binds this filename to the exact published asset; the
    // updater still verifies its pinned-key signature after downloading it.
    update.download_url =
        url::Url::parse(&policy::asset_url(&candidate.version, &candidate.artifact)?)
            .map_err(|_| failure("invalid reviewed application download URL"))?;
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    Ok(Some((update, candidate)))
}

async fn cancelled(cancellation: &mut watch::Receiver<bool>) {
    loop {
        if *cancellation.borrow_and_update() {
            return;
        }
        if cancellation.changed().await.is_err() {
            return;
        }
    }
}

async fn verified_download(
    update: &Update,
    candidate: &Candidate,
    mut report: impl FnMut(&'static str, u64) -> Result<()>,
) -> Result<Vec<u8>> {
    let mut received = 0_u64;
    let (rejected, mut rejection) = watch::channel(false);
    let download = update.download(
        |size, total| {
            received = received.saturating_add(size as u64);
            if received > MAX_DOWNLOAD_BYTES
                || received > candidate.bytes
                || total.is_some_and(|total| total != candidate.bytes)
                || report("downloading", received).is_err()
            {
                rejected.send_replace(true);
            }
        },
        || {},
    );
    let bytes = tokio::select! {
        biased;
        _ = cancelled(&mut rejection) => return Err(failure("application download was interrupted or differs from the reviewed size")),
        result = tokio::time::timeout(DOWNLOAD_TIMEOUT, download) => result
            .map_err(|_| failure("application update download timed out"))?
            .map_err(|cause| failure(format!("application update download or signature verification failed: {cause}")))?,
    };
    if *rejection.borrow() || bytes.len() as u64 != candidate.bytes {
        return Err(failure(
            "application download size differs from the reviewed release",
        ));
    }
    report("verifying", candidate.bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_observes_existing_signals_and_closed_owners() {
        let (sender, mut receiver) = watch::channel(false);
        sender.send_replace(true);
        tokio::time::timeout(Duration::from_millis(100), cancelled(&mut receiver))
            .await
            .unwrap();
        let (sender, mut receiver) = watch::channel(false);
        drop(sender);
        tokio::time::timeout(Duration::from_millis(100), cancelled(&mut receiver))
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore = "explicit live published-artifact download; never executes an installer"]
    async fn live_review_and_signed_download_reject_tampering_and_interruption() {
        assert_eq!(
            std::env::var("DSH_TEST_APPLICATION_DOWNLOAD").as_deref(),
            Ok("1")
        );
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        let config: tauri::Config =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        context.config_mut().plugins = config.plugins;
        context.package_info_mut().version = semver::Version::new(0, 9, 20);
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        let (mut update, candidate) = checked_candidate(app.handle(), Some("0.9.19"))
            .await
            .unwrap()
            .expect("published stable release");
        assert_eq!(candidate.version, "0.9.19");
        let mut phases = Vec::new();
        let bytes = verified_download(&update, &candidate, |phase, _| {
            phases.push(phase);
            Ok(())
        })
        .await
        .expect("published bytes verify with the committed public key");
        assert_eq!(bytes.len() as u64, candidate.bytes);
        assert_eq!(phases.last(), Some(&"verifying"));
        drop(bytes);

        let interrupted =
            verified_download(&update, &candidate, |_, _| Err(failure("window closed")))
                .await
                .unwrap_err()
                .to_string();
        assert!(interrupted.contains("interrupted") || interrupted.contains("size differs"));

        let mut wrong_size = candidate.clone();
        wrong_size.bytes -= 1;
        assert!(verified_download(&update, &wrong_size, |_, _| Ok(()))
            .await
            .is_err());

        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;
        let decoded = String::from_utf8(engine.decode(&update.signature).unwrap()).unwrap();
        let mut lines: Vec<String> = decoded.lines().map(str::to_owned).collect();
        let mut signature = lines[1].as_bytes().to_vec();
        signature[20] = if signature[20] == b'A' { b'B' } else { b'A' };
        lines[1] = String::from_utf8(signature).unwrap();
        update.signature = engine.encode(format!("{}\n", lines.join("\n")));
        let tampered = verified_download(&update, &candidate, |_, _| Ok(()))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            tampered.contains("signature verification failed"),
            "{tampered}"
        );
        println!("Verified published {} ({} bytes), cancellation, size mismatch and tampered signature; no installer executed", candidate.artifact, candidate.bytes);
    }
}

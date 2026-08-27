//! Renderer-independent startup recovery.
//!
//! The normal recovery center is React because it is part of the product. This
//! window exists for the narrower case where React itself never commits. Its
//! document is a pair of static files bundled beside `index.html`; it does not
//! import the application bundle, start Harness, execute Node, or use a network.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::{Error, Result};

const LABEL: &str = "startup-recovery";
const DEADLINE: Duration = Duration::from_secs(12);
const WIDTH: f64 = 620.0;
const HEIGHT: f64 = 500.0;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererFailure {
    pub window: String,
    pub reason: String,
}

#[derive(Default)]
pub struct RendererHealth {
    windows: Mutex<HashMap<String, WindowHealth>>,
    failure: Mutex<Option<RendererFailure>>,
}

#[derive(Default)]
struct WindowHealth {
    generation: u64,
    ready: bool,
    document: Option<String>,
}

impl RendererHealth {
    fn watch(&self, label: &str) -> u64 {
        let Ok(mut windows) = self.windows.lock() else {
            return 0;
        };
        let state = windows.entry(label.to_string()).or_default();
        state.generation = state.generation.saturating_add(1);
        state.ready = false;
        state.document = None;
        state.generation
    }

    fn ready(&self, label: &str, document: String) {
        if let Ok(mut windows) = self.windows.lock() {
            let state = windows.entry(label.to_string()).or_default();
            state.ready = true;
            state.document = Some(document);
        }
        if let Ok(mut failure) = self.failure.lock() {
            if failure
                .as_ref()
                .is_some_and(|failed| failed.window == label)
            {
                *failure = None;
            }
        }
    }

    fn rearm(&self, label: &str, document: &str) -> Option<u64> {
        let mut windows = self.windows.lock().ok()?;
        let state = windows.get_mut(label)?;
        if state.document.as_deref() != Some(document) {
            return None;
        }
        state.generation = state.generation.saturating_add(1);
        state.ready = false;
        Some(state.generation)
    }

    fn fail_if_pending(
        &self,
        label: &str,
        generation: u64,
        reason: &str,
    ) -> Option<RendererFailure> {
        let pending = self
            .windows
            .lock()
            .ok()
            .and_then(|windows| {
                windows
                    .get(label)
                    .map(|state| state.generation == generation && !state.ready)
            })
            .unwrap_or(false);
        if !pending {
            return None;
        }
        let failure = RendererFailure {
            window: label.to_string(),
            reason: bounded_reason(reason),
        };
        if let Ok(mut current) = self.failure.lock() {
            *current = Some(failure.clone());
        }
        Some(failure)
    }

    fn fail_current(&self, label: &str, reason: &str) -> Option<RendererFailure> {
        let generation = self.windows.lock().ok()?.get(label)?.generation;
        self.fail_if_pending(label, generation, reason)
    }

    fn failure(&self) -> Option<RendererFailure> {
        self.failure.lock().ok()?.clone()
    }
}

fn bounded_reason(reason: &str) -> String {
    reason.chars().take(1_024).collect()
}

/// Arm the independent recovery deadline for one application window.
pub fn watch<R: Runtime>(window: &WebviewWindow<R>) {
    let label = window.label().to_string();
    let app = window.app_handle().clone();
    let generation = app.state::<RendererHealth>().watch(&label);
    watch_generation(app, label, generation);
}

fn watch_generation<R: Runtime>(app: AppHandle<R>, label: String, generation: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DEADLINE).await;
        let health = app.state::<RendererHealth>();
        if let Some(failure) = health.fail_if_pending(
            &label,
            generation,
            "the application renderer did not complete its first frame",
        ) {
            show(&app, &failure);
        }
    });
}

/// First committed React frame. Idempotent because Strict Mode mounts twice in development.
#[tauri::command]
pub fn renderer_ready(
    window: WebviewWindow,
    health: tauri::State<RendererHealth>,
    document: String,
) {
    health.ready(window.label(), document);
    if let Some(recovery) = window.app_handle().get_webview_window(LABEL) {
        let _ = recovery.close();
    }
}

/// Re-arm the native deadline immediately before a renderer document reloads.
///
/// A stale split chunk can fail after the first React commit, when the normal
/// watchdog has already been cancelled. The next document must get its own
/// deadline, and the old timer must not be allowed to race it.
#[tauri::command]
pub fn renderer_reloading(
    window: WebviewWindow,
    health: tauri::State<RendererHealth>,
    document: String,
) {
    let Some(generation) = health.rearm(window.label(), &document) else {
        return;
    };
    watch_generation(
        window.app_handle().clone(),
        window.label().to_string(),
        generation,
    );
}

/// Uncaught startup failure captured before the renderer became healthy.
pub fn renderer_failed<R: Runtime>(window: &WebviewWindow<R>, reason: &str) {
    let app = window.app_handle();
    let health = app.state::<RendererHealth>();
    if let Some(failure) = health.fail_current(window.label(), reason) {
        show(app, &failure);
    }
}

#[tauri::command]
pub fn recovery_state(health: tauri::State<RendererHealth>) -> Option<RendererFailure> {
    health.failure()
}

#[tauri::command]
pub fn recovery_retry(app: AppHandle, health: tauri::State<RendererHealth>) -> Result<()> {
    let failure = health
        .failure()
        .ok_or_else(|| Error::Window("there is no failed renderer to retry".into()))?;
    let window = app
        .get_webview_window(&failure.window)
        .ok_or_else(|| Error::Window("the failed application window no longer exists".into()))?;

    watch(&window);
    if let Some(recovery) = app.get_webview_window(LABEL) {
        let _ = recovery.hide();
    }
    window.eval("window.location.reload()").map_err(|cause| {
        Error::Window(format!(
            "the application interface could not reload: {cause}"
        ))
    })?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn recovery_export_diagnostics() -> Result<String> {
    tokio::task::spawn_blocking(|| crate::diagnostics::export_headless(env!("CARGO_PKG_VERSION")))
        .await
        .map_err(|cause| Error::Report(format!("exporting startup diagnostics failed: {cause}")))??
        .into_os_string()
        .into_string()
        .map_err(|_| Error::Report("the diagnostic path cannot be displayed as text".into()))
}

#[tauri::command]
pub fn recovery_quit(app: AppHandle) {
    app.exit(1);
}

fn show<R: Runtime>(app: &AppHandle<R>, failure: &RendererFailure) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }

    let built =
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PathBuf::from("recovery.html")))
            .title(crate::locale::pick(
                "DSH Studio startup recovery",
                "DSH Studio 启动恢复",
            ))
            .inner_size(WIDTH, HEIGHT)
            .min_inner_size(520.0, 420.0)
            .center()
            .build();
    if let Err(cause) = built {
        eprintln!(
            "DSH Studio could not open renderer recovery for {}: {cause}",
            failure.window
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_renderer_cannot_be_failed_by_an_old_deadline() {
        let health = RendererHealth::default();
        let generation = health.watch("main");
        health.ready("main", "document-1".into());
        assert_eq!(
            health.fail_if_pending("main", generation, "late timer"),
            None
        );
        assert_eq!(health.failure(), None);
    }

    #[test]
    fn retry_rearms_only_the_named_window() {
        let health = RendererHealth::default();
        health.ready("main", "main-document".into());
        health.ready("work-2", "work-document".into());
        let work_generation = health.watch("work-2");
        assert!(health.fail_current("main", "should stay healthy").is_none());
        assert_eq!(
            health.fail_if_pending("work-2", work_generation, "did not paint"),
            Some(RendererFailure {
                window: "work-2".into(),
                reason: "did not paint".into(),
            })
        );
    }

    #[test]
    fn failure_reason_is_bounded_before_crossing_into_static_ui() {
        let health = RendererHealth::default();
        let reason = "x".repeat(2_048);
        let generation = health.watch("main");
        let failure = health.fail_if_pending("main", generation, &reason).unwrap();
        assert_eq!(failure.reason.chars().count(), 1_024);
    }

    #[test]
    fn an_old_deadline_cannot_fail_a_reloaded_document() {
        let health = RendererHealth::default();
        let old = health.watch("main");
        health.ready("main", "old-document".into());
        let current = health.watch("main");

        assert_eq!(health.fail_if_pending("main", old, "old timer"), None);
        assert!(health
            .fail_if_pending("main", current, "current timer")
            .is_some());
    }

    #[test]
    fn a_late_rearm_from_an_old_document_cannot_replace_new_health() {
        let health = RendererHealth::default();
        health.watch("main");
        health.ready("main", "old-document".into());
        assert!(health.rearm("main", "old-document").is_some());
        health.ready("main", "new-document".into());

        assert_eq!(health.rearm("main", "old-document"), None);
        assert!(health.fail_current("main", "new page is healthy").is_none());
    }
}

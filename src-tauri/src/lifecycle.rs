//! Coordinate document quiescence across every shell window before destructive lifecycle work.
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tokio::sync::oneshot;

use crate::error::{Error, Result};

#[derive(Default)]
pub struct Lifecycle {
    pending: Mutex<Option<Pending>>,
    exit_allowed: AtomicBool,
}

struct Pending {
    id: String,
    participants: BTreeSet<String>,
    remaining: BTreeSet<String>,
    completion: Option<oneshot::Sender<bool>>,
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct PendingLifecycle {
    id: String,
    awaiting: bool,
}

fn failure() -> Error {
    Error::Window("Save unfinished documents in every window and retry; an unavailable window also prevents this operation".into())
}

impl Lifecycle {
    /// Only the renderer-independent recovery UI may explicitly abandon crashed windows.
    pub fn abandon_for_recovery(&self) {
        self.exit_allowed.store(true, Ordering::SeqCst);
    }
    fn begin(
        &self,
        labels: impl FnOnce() -> BTreeSet<String>,
    ) -> Result<(String, oneshot::Receiver<bool>)> {
        let mut pending = self.pending.lock().map_err(|_| failure())?;
        if pending.is_some() {
            return Err(failure());
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| failure())?;
        let id = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let (tx, rx) = oneshot::channel();
        let participants = labels();
        let mut request = Pending {
            id: id.clone(),
            remaining: participants.clone(),
            participants,
            completion: Some(tx),
        };
        if request.remaining.is_empty() {
            let _ = request.completion.take().unwrap().send(true);
        }
        *pending = Some(request);
        Ok((id, rx))
    }

    fn reply(&self, window: &str, id: &str, ready: bool) -> Result<()> {
        let mut pending = self.pending.lock().map_err(|_| failure())?;
        let request = pending
            .as_mut()
            .filter(|request| request.id == id)
            .ok_or_else(failure)?;
        if !request.remaining.remove(window) {
            return Err(failure());
        }
        if !ready || request.remaining.is_empty() {
            if let Some(tx) = request.completion.take() {
                let _ = tx.send(ready);
            }
        }
        Ok(())
    }

    fn release(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            if pending.as_ref().is_some_and(|request| request.id == id) {
                *pending = None;
            }
        }
    }

    fn snapshot(&self, window: &str) -> Result<Option<PendingLifecycle>> {
        let pending = self.pending.lock().map_err(|_| failure())?;
        Ok(pending
            .as_ref()
            .filter(|request| request.participants.contains(window))
            .map(|request| PendingLifecycle {
                id: request.id.clone(),
                awaiting: request.remaining.contains(window),
            }))
    }

    /// Serialize window creation against taking the lifecycle window snapshot.
    pub fn with_idle<T>(&self, work: impl FnOnce() -> Result<T>) -> Result<T> {
        let pending = self.pending.lock().map_err(|_| failure())?;
        if pending.is_some() {
            return Err(failure());
        }
        work()
    }
}

pub struct Lease<R: Runtime> {
    app: AppHandle<R>,
    id: String,
    committed: bool,
}

impl<R: Runtime> Lease<R> {
    pub fn commit(mut self) {
        self.app
            .state::<Lifecycle>()
            .exit_allowed
            .store(true, Ordering::SeqCst);
        self.committed = true;
    }
}

impl<R: Runtime> Drop for Lease<R> {
    fn drop(&mut self) {
        if !self.committed {
            self.app.state::<Lifecycle>().release(&self.id);
            let _ = self.app.emit("application://lifecycle-release", &self.id);
        }
    }
}

pub async fn acquire<R: Runtime>(app: &AppHandle<R>) -> Result<Lease<R>> {
    // Window creation holds the same mutex until the new window is registered.
    // Taking the snapshot inside begin's critical section is required as well.
    let state = app.state::<Lifecycle>();
    let mut windows = std::collections::HashMap::new();
    let (id, rx) = state.begin(|| {
        windows = app.webview_windows();
        windows
            .keys()
            .filter(|label| label.as_str() == "main" || label.starts_with("work-"))
            .cloned()
            .collect()
    })?;
    let lease = Lease {
        app: app.clone(),
        id: id.clone(),
        committed: false,
    };
    for (label, window) in windows {
        if label == "main" || label.starts_with("work-") {
            window
                .emit("application://lifecycle-prepare", &id)
                .map_err(|_| failure())?;
        }
    }
    if !tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| failure())?
        .map_err(|_| failure())?
    {
        return Err(failure());
    }
    Ok(lease)
}

#[tauri::command]
pub fn application_lifecycle_state(
    window: WebviewWindow,
    state: State<'_, Lifecycle>,
) -> Result<Option<PendingLifecycle>> {
    state.snapshot(window.label())
}

#[tauri::command]
pub fn application_lifecycle_reply(
    window: WebviewWindow,
    state: State<'_, Lifecycle>,
    id: String,
    ready: bool,
) -> Result<()> {
    state.reply(window.label(), &id, ready)
}

pub fn request<R: Runtime>(app: &AppHandle<R>, restart: bool, code: i32) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match acquire(&app).await {
            Ok(lease) => {
                lease.commit();
                if restart {
                    app.request_restart();
                } else {
                    app.exit(code);
                }
            }
            Err(_) => {
                if let Some(window) = crate::window::front(&app) {
                    crate::window::reveal(&window);
                }
                let _ = app.emit("application://lifecycle-blocked", ());
            }
        }
    });
}

pub fn on_exit<R: Runtime>(app: &AppHandle<R>, code: Option<i32>, api: &tauri::ExitRequestApi) {
    if app.state::<Lifecycle>().exit_allowed.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_exit();
    request(app, false, code.unwrap_or(0));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_window_must_reply_and_receipts_are_bound_to_window_and_request() {
        let state = Lifecycle::default();
        let (id, mut rx) = state
            .begin(|| ["main".into(), "work-2".into()].into())
            .unwrap();
        assert!(state.begin(BTreeSet::new).is_err());
        assert!(state.with_idle(|| Ok(())).is_err());
        assert!(state.reply("other", &id, true).is_err());
        assert!(state.reply("main", "stale", true).is_err());
        assert_eq!(
            state.snapshot("main").unwrap(),
            Some(PendingLifecycle {
                id: id.clone(),
                awaiting: true
            })
        );
        assert_eq!(state.snapshot("other").unwrap(), None);
        state.reply("main", &id, true).unwrap();
        assert_eq!(
            state.snapshot("main").unwrap(),
            Some(PendingLifecycle {
                id: id.clone(),
                awaiting: false
            })
        );
        assert!(rx.try_recv().is_err());
        assert!(state.reply("main", &id, true).is_err());
        state.release("stale");
        assert!(state.with_idle(|| Ok(())).is_err());
        state.reply("work-2", &id, true).unwrap();
        assert!(rx.await.unwrap());
        // Approval keeps the lease held until the caller releases or exits.
        assert!(state.with_idle(|| Ok(())).is_err());
        state.release(&id);
        assert_eq!(state.snapshot("main").unwrap(), None);
        assert!(state.with_idle(|| Ok(())).is_ok());
    }

    #[tokio::test]
    async fn refusal_missing_reply_and_empty_roster_have_distinct_results() {
        let state = Lifecycle::default();
        let (id, rx) = state
            .begin(|| ["main".into(), "work-2".into()].into())
            .unwrap();
        state.reply("main", &id, false).unwrap();
        assert!(!rx.await.unwrap());
        state.reply("work-2", &id, true).unwrap();
        state.release(&id);
        let (id, rx) = state.begin(|| ["main".into()].into()).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(20), rx)
            .await
            .is_err());
        state.release(&id);
        let (id, rx) = state.begin(BTreeSet::new).unwrap();
        assert!(rx.await.unwrap());
        state.release(&id);
    }

    #[test]
    fn poisoned_coordination_fails_closed() {
        let state = Lifecycle::default();
        let _ = std::panic::catch_unwind(|| {
            let _guard = state.pending.lock().unwrap();
            panic!("poison fixture");
        });
        assert!(state.begin(BTreeSet::new).is_err());
        assert!(state.reply("main", "id", true).is_err());
        assert!(state.snapshot("main").is_err());
        assert!(state.with_idle(|| Ok(())).is_err());
        state.release("id");
    }
}

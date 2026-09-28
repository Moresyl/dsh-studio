//! Bounded, window-owned reviews and one cancellable installer across the app.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::error::{Error, Result};

use super::catalog::failure;
use super::policy::Candidate;

const REVIEW_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_REVIEWS: usize = 16;

struct Review {
    owner: String,
    candidate: Candidate,
    created: Instant,
    cancelled: bool,
}

struct Active {
    id: String,
    owner: String,
    committing: bool,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
struct Inner {
    reviews: HashMap<String, Review>,
    active: Option<Active>,
}

#[derive(Default)]
pub struct UpdateState(Mutex<Inner>);

impl UpdateState {
    /// Hold admission through a synchronous terminal spawn, so committing an
    /// update cannot miss a child created between its final check and shutdown.
    pub(crate) fn admit<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let inner = self.lock()?;
        if inner
            .active
            .as_ref()
            .is_some_and(|active| active.committing)
        {
            return Err(failure(
                "the application is being replaced; restart before opening a terminal",
            ));
        }
        operation()
    }

    fn lock(&self) -> Result<MutexGuard<'_, Inner>> {
        self.0
            .lock()
            .map_err(|_| failure("application updater state is unavailable; restart and retry"))
    }

    pub(super) fn remember(&self, owner: &str, candidate: Candidate) -> Result<String> {
        self.remember_at(owner, candidate, Instant::now())
    }

    fn remember_at(&self, owner: &str, candidate: Candidate, now: Instant) -> Result<String> {
        let mut inner = self.lock()?;
        inner
            .reviews
            .retain(|_, review| now.saturating_duration_since(review.created) < REVIEW_TTL);
        if inner.reviews.len() >= MAX_REVIEWS {
            if let Some(oldest) = inner
                .reviews
                .iter()
                .min_by_key(|(_, review)| review.created)
                .map(|(id, _)| id.clone())
            {
                inner.reviews.remove(&oldest);
            }
        }
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| Error::NoEntropy)?;
        let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        if inner.reviews.contains_key(&id) {
            return Err(failure(
                "could not allocate an application update review; retry",
            ));
        }
        inner.reviews.insert(
            id.clone(),
            Review {
                owner: owner.into(),
                candidate,
                created: now,
                cancelled: false,
            },
        );
        Ok(id)
    }

    pub(super) fn discard(&self, owner: &str, id: &str) -> Result<()> {
        let mut inner = self.lock()?;
        if inner
            .reviews
            .get(id)
            .is_some_and(|review| review.owner == owner)
        {
            inner.reviews.remove(id);
        }
        Ok(())
    }

    pub(super) fn claim(&self, owner: &str, id: &str) -> Result<(Candidate, Job<'_>)> {
        self.claim_at(owner, id, Instant::now())
    }

    fn claim_at(&self, owner: &str, id: &str, now: Instant) -> Result<(Candidate, Job<'_>)> {
        let mut inner = self.lock()?;
        if inner.active.is_some() {
            return Err(failure(
                "an application update is already running or waiting for restart",
            ));
        }
        let review = inner.reviews.get(id).ok_or_else(|| {
            failure("application update review expired; review the release again")
        })?;
        if review.owner != owner {
            return Err(failure(
                "application update review belongs to another window",
            ));
        }
        if review.cancelled {
            inner.reviews.remove(id);
            return Err(failure("application update cancelled"));
        }
        if now.saturating_duration_since(review.created) >= REVIEW_TTL {
            inner.reviews.remove(id);
            return Err(failure(
                "application update review expired; review the release again",
            ));
        }
        let review = inner
            .reviews
            .remove(id)
            .ok_or_else(|| failure("application update review was consumed"))?;
        let (cancel, cancellation) = watch::channel(false);
        inner.active = Some(Active {
            id: id.into(),
            owner: owner.into(),
            committing: false,
            cancel,
        });
        Ok((
            review.candidate,
            Job {
                state: self,
                id: id.into(),
                cancellation,
                installed: false,
            },
        ))
    }

    pub(super) fn cancel(&self, owner: &str, id: &str) -> Result<bool> {
        let mut inner = self.lock()?;
        let Some(active) = inner.active.as_ref() else {
            // IPC dispatch order is not guaranteed. A cancel can reach native
            // code after review renewal but just before the install claims it.
            if let Some(review) = inner.reviews.get_mut(id) {
                if review.owner != owner {
                    return Err(failure("this window does not own that application update"));
                }
                review.cancelled = true;
                return Ok(true);
            }
            return Ok(false);
        };
        if active.owner != owner || active.id != id {
            return Err(failure("this window does not own that application update"));
        }
        if active.committing {
            return Err(failure(
                "the installer has started and can no longer be cancelled",
            ));
        }
        active.cancel.send_replace(true);
        Ok(true)
    }
}

pub(super) struct Job<'a> {
    state: &'a UpdateState,
    id: String,
    cancellation: watch::Receiver<bool>,
    installed: bool,
}

impl Job<'_> {
    pub(super) fn cancellation(&self) -> watch::Receiver<bool> {
        self.cancellation.clone()
    }

    /// Cancellation and committing share the same lock, so neither can race past the other.
    pub(super) fn commit(&self) -> Result<()> {
        let mut inner = self.state.lock()?;
        let active = inner
            .active
            .as_mut()
            .filter(|active| active.id == self.id)
            .ok_or_else(|| failure("application update is no longer active"))?;
        if *active.cancel.borrow() {
            return Err(failure("application update cancelled"));
        }
        active.committing = true;
        Ok(())
    }

    pub(super) fn installed(&mut self) {
        // Keep the process-wide claim until restart. A failed relaunch must not
        // allow another installer to run against an already replaced executable.
        self.installed = true;
    }
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        if self.installed {
            return;
        }
        if let Ok(mut inner) = self.state.0.lock() {
            if inner
                .active
                .as_ref()
                .is_some_and(|active| active.id == self.id)
            {
                inner.active = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::policy::tests::candidate;
    use super::*;

    #[test]
    fn cancellation_before_ipc_install_admission_is_not_lost() {
        let state = UpdateState::default();
        let id = state.remember("main", candidate()).unwrap();
        assert!(state.cancel("other", &id).is_err());
        assert!(state.cancel("main", &id).unwrap());
        assert!(
            matches!(state.claim("main", &id), Err(cause) if cause.to_string().contains("application update cancelled"))
        );
        assert!(!state.cancel("main", &id).unwrap());
        let next = state.remember("main", candidate()).unwrap();
        assert!(state.claim("main", &next).is_ok());
    }

    #[test]
    fn reviews_are_window_owned_and_consumed_once() {
        let state = UpdateState::default();
        let id = state.remember("main", candidate()).unwrap();
        assert!(state.claim("work-2", &id).is_err());
        state.discard("work-2", &id).unwrap();
        let (selected, job) = state.claim("main", &id).unwrap();
        assert_eq!(selected, candidate());
        drop(job);
        assert!(state.claim("main", &id).is_err());
    }

    #[test]
    fn a_second_window_cannot_start_or_cancel_an_active_installer() {
        let state = UpdateState::default();
        let first = state.remember("main", candidate()).unwrap();
        let second = state.remember("work-2", candidate()).unwrap();
        let (_, job) = state.claim("main", &first).unwrap();
        assert!(state.claim("work-2", &second).is_err());
        assert!(state.cancel("work-2", &first).is_err());
        assert!(state.cancel("main", &second).is_err());
        drop(job);
        assert!(state.claim("work-2", &second).is_ok());
    }

    #[test]
    fn cancelling_before_commit_prevents_install_and_frees_the_slot_after_drop() {
        let state = UpdateState::default();
        let id = state.remember("main", candidate()).unwrap();
        let (_, job) = state.claim("main", &id).unwrap();
        let cancellation = job.cancellation();
        assert!(state.cancel("main", &id).unwrap());
        assert!(*cancellation.borrow());
        assert!(job.commit().is_err());
        drop(job);
        assert!(!state.cancel("main", &id).unwrap());
        let retry = state.remember("main", candidate()).unwrap();
        assert!(state.claim("main", &retry).is_ok());
    }

    #[test]
    fn commit_is_a_cancellation_boundary_and_success_requires_restart() {
        let state = UpdateState::default();
        let id = state.remember("main", candidate()).unwrap();
        let (_, mut job) = state.claim("main", &id).unwrap();
        job.commit().unwrap();
        assert!(state.cancel("main", &id).is_err());
        job.installed();
        drop(job);
        let next = state.remember("main", candidate()).unwrap();
        assert!(state.claim("main", &next).is_err());
    }

    #[test]
    fn installer_failure_releases_even_a_committing_job() {
        let state = UpdateState::default();
        let id = state.remember("main", candidate()).unwrap();
        let (_, job) = state.claim("main", &id).unwrap();
        job.commit().unwrap();
        drop(job);
        let retry = state.remember("main", candidate()).unwrap();
        assert!(state.claim("main", &retry).is_ok());
    }

    #[test]
    fn terminal_admission_stops_at_commit_and_recovers_after_failure() {
        let state = UpdateState::default();
        assert_eq!(state.admit(|| Ok(7)).unwrap(), 7);
        let id = state.remember("main", candidate()).unwrap();
        let (_, job) = state.claim("main", &id).unwrap();
        assert!(state.admit(|| Ok(())).is_ok());
        job.commit().unwrap();
        assert!(state.admit(|| Ok(())).is_err());
        drop(job);
        assert!(state.admit(|| Ok(())).is_ok());
    }

    #[test]
    fn expired_reviews_are_rejected_and_storage_is_bounded() {
        let state = UpdateState::default();
        let now = Instant::now();
        let id = state.remember_at("main", candidate(), now).unwrap();
        assert!(state.claim_at("main", &id, now + REVIEW_TTL).is_err());
        assert!(state.lock().unwrap().reviews.is_empty());
        for index in 0..MAX_REVIEWS + 5 {
            state
                .remember_at("main", candidate(), now + Duration::from_secs(index as u64))
                .unwrap();
        }
        assert_eq!(state.lock().unwrap().reviews.len(), MAX_REVIEWS);
        let id = state
            .remember_at(
                "main",
                candidate(),
                now + REVIEW_TTL + Duration::from_secs(100),
            )
            .unwrap();
        assert_eq!(state.lock().unwrap().reviews.len(), 1);
        state.discard("main", &id).unwrap();
        assert!(state.lock().unwrap().reviews.is_empty());
    }
}

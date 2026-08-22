//! Keep one `dsh web` process alive and observable.
//!
//! The shell makes one promise: the local service does not silently disappear.
//! That means owning the whole lifecycle — bounded startup, streamed output,
//! crash detection, and backoff restart — in one place, and exposing it as a
//! state machine the UI can render honestly.

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use proc_guard::ProcessGuard;
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, oneshot};

use super::health;
use super::readiness::{self, Ready};
use crate::error::{Error, Result};

/// How long the harness gets to announce its port before it is considered stuck.
///
/// Cold starts load ~190 plugins off disk, so this is generous on purpose; a
/// tighter bound would fire on slow disks rather than on real failures.
const READINESS_TIMEOUT: Duration = Duration::from_secs(120);

/// Backoff schedule for unexpected exits. Running out means giving up.
const RESTART_DELAYS_MS: [u64; 5] = [500, 1_000, 2_000, 5_000, 10_000];

/// Gap between health probes once the harness is serving.
const HEALTH_INTERVAL: Duration = Duration::from_secs(10);

/// How long one probe may take before it counts as a miss.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);

/// Consecutive misses tolerated before the harness is treated as wedged.
///
/// The harness runs model turns and tool calls, so it is allowed to be busy;
/// three misses is half a minute of not answering at all, which is not busy.
const HEALTH_MISS_LIMIT: u32 = 3;

/// Lines of harness output kept for the log panel.
const LOG_HISTORY: usize = 2_000;

/// Which pipe a log line came from.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stream {
    Stdout,
    Stderr,
}

/// What the harness is doing right now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "phase",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Status {
    Stopped,
    Starting,
    Ready { origin: String, pid: u32 },
    Restarting { attempt: u32, delay_ms: u64 },
    Failed { reason: String },
}

/// Something the UI should react to.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Event {
    Status(Status),
    Log { stream: Stream, line: String },
}

/// Everything needed to start the harness once.
#[derive(Clone, Debug)]
pub struct LaunchPlan {
    /// Node executable that will run the harness.
    pub node: PathBuf,
    /// Path to the harness CLI entry point.
    pub entry: PathBuf,
    /// Profile to boot: which layer stack the harness composes, and therefore
    /// which plugins the session has.
    pub profile: String,
    /// Runtime-owned patch layers. They are supplied for this process instead
    /// of being persisted in the user's profile bundle stack.
    pub patches: Vec<PathBuf>,
    /// Working directory inherited by agent sessions and their tools.
    pub workspace: PathBuf,
    /// Interface to bind. Loopback unless the user opts into remote access.
    pub host: String,
    /// Listen port, or `0` to let the OS choose a free one.
    pub port: u16,
    /// Selected login-shell exports for GUI launches. Empty on Windows/dev.
    pub environment: BTreeMap<String, String>,
}

impl LaunchPlan {
    fn launcher_command(&self) -> Command {
        let mut command = Command::new(&self.node);
        command
            .arg(&self.entry)
            // Named rather than using the `web` alias, and before the arguments
            // meant for the profile's own application: the launcher stops reading
            // its own flags at the first token it does not recognise and hands
            // everything after it on. `web` would say all of this for exactly one
            // profile.
            .arg("--profile")
            .arg(&self.profile);
        for patch in &self.patches {
            command.arg("--patch").arg(patch);
        }
        command
            .current_dir(&self.workspace)
            // Lets harness plugins detect that a native shell owns the session.
            .env("DSH_DESKTOP", "1");
        command.envs(&self.environment);
        command
    }

    fn to_command(&self) -> Command {
        let mut command = self.launcher_command();
        command
            // The Web surface opens the operating-system browser by default.
            // Studio owns presentation inside its Tauri window, so every boot
            // and restart must explicitly suppress that handoff.
            .arg("--no-open")
            .arg("--host")
            .arg(&self.host)
            .arg("--port")
            .arg(self.port.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        command
    }

    /// Ask the Harness launcher to compose the exact profile without booting
    /// its plugins. Used to reject loader conflicts before startup log noise.
    pub(super) fn dump_command(&self) -> Command {
        let mut command = self.launcher_command();
        command
            .arg("--dump-config")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        command
    }
}

/// Owns the harness process and everything derived from it.
pub struct Supervisor {
    guard: ProcessGuard,
    events: broadcast::Sender<Event>,
    status: Mutex<Status>,
    log: Mutex<VecDeque<(Stream, String)>>,
    persistent_log: Mutex<crate::logging::PersistentLog>,
    /// Set while a supervision loop owns a child, so `start` is idempotent.
    active: AtomicBool,
    /// Set by `stop`, so the supervision loop knows an exit was intentional.
    stopping: AtomicBool,
}

impl Supervisor {
    pub fn new() -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            guard: ProcessGuard::new().map_err(Error::ProcessGuard)?,
            events: broadcast::channel(512).0,
            status: Mutex::new(Status::Stopped),
            log: Mutex::new(VecDeque::with_capacity(LOG_HISTORY)),
            persistent_log: Mutex::new(crate::logging::PersistentLog::managed()),
            active: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
        }))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// The guard that owns every process this shell starts.
    ///
    /// Shared so that work adjacent to the harness — installing it, for one —
    /// is reclaimed by the same mechanism rather than a second one.
    pub(crate) fn guard(&self) -> &ProcessGuard {
        &self.guard
    }

    /// Add a line to the shell's activity log from outside the supervisor.
    pub(crate) fn note(&self, stream: Stream, line: String) {
        self.record(stream, line);
    }

    pub fn status(&self) -> Status {
        self.status.lock().expect("status poisoned").clone()
    }

    /// Recent harness output, oldest first.
    pub fn recent_log(&self) -> Vec<(Stream, String)> {
        self.log
            .lock()
            .expect("log poisoned")
            .iter()
            .cloned()
            .collect()
    }

    pub fn persistent_log_path(&self) -> Option<PathBuf> {
        self.persistent_log
            .lock()
            .expect("persistent log poisoned")
            .path()
    }

    /// Change the disk log threshold without filtering the live console.
    pub fn set_log_level(&self, level: crate::logging::LogLevel) -> Result<()> {
        self.persistent_log
            .lock()
            .expect("persistent log poisoned")
            .set_level(level)
    }

    /// Start the harness and return the origin it is serving on.
    ///
    /// The first attempt runs inline so a misconfigured launch reports a real
    /// error instead of disappearing into a retry loop. Only once the harness
    /// has proven it can start does supervision move to the background.
    pub async fn start(self: Arc<Self>, plan: LaunchPlan) -> Result<String> {
        if let Status::Ready { origin, .. } = self.status() {
            return Ok(origin);
        }
        if self.active.swap(true, Ordering::SeqCst) {
            return Err(Error::AlreadyStarting);
        }
        self.stopping.store(false, Ordering::SeqCst);
        self.publish(Status::Starting);

        let started = Arc::clone(&self).launch_once(&plan).await;
        match started {
            Ok((child, origin)) => {
                let pid = child.id().unwrap_or_default();
                self.publish(Status::Ready {
                    origin: origin.clone(),
                    pid,
                });
                tokio::spawn(async move { self.supervise(child, plan).await });
                Ok(origin)
            }
            Err(failure) => {
                self.active.store(false, Ordering::SeqCst);
                self.publish(Status::Failed {
                    reason: failure.to_string(),
                });
                Err(failure)
            }
        }
    }

    /// Stop the harness and leave it stopped.
    pub async fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        // The guard owns the tree, so this reaches tool subprocesses too.
        let _ = self.guard.terminate_all();
        self.publish(Status::Stopped);
    }

    /// Run one launch attempt to readiness.
    async fn launch_once(self: Arc<Self>, plan: &LaunchPlan) -> Result<(Child, String)> {
        let mut command = plan.to_command();
        let mut child = self.guard.spawn(&mut command).map_err(Error::Spawn)?;

        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let (ready_tx, ready_rx) = oneshot::channel();

        tokio::spawn(Arc::clone(&self).pump(stdout, Stream::Stdout, Some(ready_tx)));
        tokio::spawn(Arc::clone(&self).pump(stderr, Stream::Stderr, None));

        let outcome = tokio::select! {
            announced = ready_rx => match announced {
                Ok(Ready::At(origin)) => Ok(origin),
                Ok(Ready::Rejected(reason)) => Err(Error::Readiness(reason)),
                // The pump dropped the sender, which only happens at EOF.
                Err(_) => Err(Error::Readiness(
                    "harness closed its output without announcing a port".into(),
                )),
            },
            exit = child.wait() => Err(Error::Readiness(match exit {
                Ok(status) => format!("harness exited during startup ({status})"),
                Err(cause) => format!("harness could not be waited on: {cause}"),
            })),
            _ = tokio::time::sleep(READINESS_TIMEOUT) => Err(Error::Readiness(format!(
                "harness did not announce a port within {}s",
                READINESS_TIMEOUT.as_secs()
            ))),
        };

        match outcome {
            Ok(origin) => Ok((child, origin)),
            Err(failure) => {
                let _ = child.kill().await;
                Err(failure)
            }
        }
    }

    /// Forward one pipe into the log and, for stdout, watch for readiness.
    async fn pump<R>(
        self: Arc<Self>,
        pipe: R,
        stream: Stream,
        mut ready: Option<oneshot::Sender<Ready>>,
    ) where
        R: tokio::io::AsyncRead + Unpin,
    {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if ready.is_some() {
                if let Some(announcement) = readiness::parse(&line) {
                    // `take` leaves `None`, so a second announcement is ignored
                    // rather than treated as a conflict.
                    if let Some(sender) = ready.take() {
                        let _ = sender.send(announcement);
                    }
                }
            }
            self.record(stream, line);
        }
    }

    /// Watch a ready harness and bring it back if it dies — or goes quiet.
    async fn supervise(self: Arc<Self>, first: Child, plan: LaunchPlan) {
        let mut child = first;

        loop {
            let exit = tokio::select! {
                exit = child.wait() => exit,
                // A wedged harness is ended here rather than restarted here, so
                // recovery keeps going through the one backoff path below.
                reason = self.watch_health() => {
                    self.record(Stream::Stderr, format!("harness stopped answering: {reason}"));
                    let _ = child.kill().await;
                    child.wait().await
                }
            };
            if self.stopping.load(Ordering::SeqCst) {
                break;
            }

            self.record(
                Stream::Stderr,
                match exit {
                    Ok(status) => format!("harness exited unexpectedly ({status})"),
                    Err(cause) => format!("harness could not be waited on: {cause}"),
                },
            );

            match Arc::clone(&self).revive(&plan).await {
                Some(restarted) => child = restarted,
                None => break,
            }
        }

        self.active.store(false, Ordering::SeqCst);
    }

    /// Poll the serving origin, returning only once it has stopped answering.
    ///
    /// One miss is not evidence: a probe can lose to a garbage collection pause
    /// or a saturated disk. Only a run of them is, so the count resets on every
    /// good reply and the caller is woken only when the run reaches its limit.
    async fn watch_health(&self) -> String {
        let mut misses = 0u32;

        loop {
            tokio::time::sleep(HEALTH_INTERVAL).await;

            // Between a restart and the next readiness there is nothing to probe.
            let Status::Ready { origin, .. } = self.status() else {
                misses = 0;
                continue;
            };

            match health::probe(&origin, HEALTH_TIMEOUT).await {
                Ok(()) => misses = 0,
                Err(reason) => {
                    misses += 1;
                    if misses >= HEALTH_MISS_LIMIT {
                        return reason;
                    }
                    self.record(
                        Stream::Stderr,
                        format!("health check missed ({misses}/{HEALTH_MISS_LIMIT}): {reason}"),
                    );
                }
            }
        }
    }

    /// Walk the backoff schedule until the harness comes back or it runs out.
    ///
    /// Returns `None` when the user asked to stop or every delay was spent.
    async fn revive(self: Arc<Self>, plan: &LaunchPlan) -> Option<Child> {
        for (index, &delay_ms) in RESTART_DELAYS_MS.iter().enumerate() {
            self.publish(Status::Restarting {
                attempt: index as u32 + 1,
                delay_ms,
            });
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            if self.stopping.load(Ordering::SeqCst) {
                return None;
            }

            match Arc::clone(&self).launch_once(plan).await {
                Ok((child, origin)) => {
                    let pid = child.id().unwrap_or_default();
                    self.publish(Status::Ready { origin, pid });
                    return Some(child);
                }
                Err(failure) => self.record(Stream::Stderr, format!("restart failed: {failure}")),
            }
        }

        self.publish(Status::Failed {
            reason: format!(
                "harness failed to come back after {} attempts",
                RESTART_DELAYS_MS.len()
            ),
        });
        None
    }

    fn publish(&self, status: Status) {
        *self.status.lock().expect("status poisoned") = status.clone();
        let _ = self.events.send(Event::Status(status));
    }

    fn record(&self, stream: Stream, line: String) {
        self.persistent_log
            .lock()
            .expect("persistent log poisoned")
            .write(stream, &line);
        {
            let mut log = self.log.lock().expect("log poisoned");
            if log.len() == LOG_HISTORY {
                log.pop_front();
            }
            log.push_back((stream, line.clone()));
        }
        let _ = self.events.send(Event::Log { stream, line });
    }
}

impl Drop for Supervisor {
    /// Stop the supervision loop from reviving a harness the app no longer owns.
    ///
    /// Reclaiming the process tree itself is the guard's job, and it happens
    /// whether or not this runs — that is the point of the guard.
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_patches_are_launcher_flags_before_web_application_arguments() {
        let plan = LaunchPlan {
            node: PathBuf::from("node"),
            entry: PathBuf::from("dsh/bin.js"),
            profile: "web".into(),
            patches: vec![PathBuf::from("studio.patch.yml")],
            workspace: PathBuf::from("workspace"),
            host: "127.0.0.1".into(),
            port: 0,
            environment: BTreeMap::new(),
        };
        let command = plan.to_command();
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(
            args,
            [
                "dsh/bin.js",
                "--profile",
                "web",
                "--patch",
                "studio.patch.yml",
                "--no-open",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
            ]
        );
    }
}

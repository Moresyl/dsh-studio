//! Spawn child processes whose entire tree is guaranteed to die with this process.
//!
//! Killing a parent does not kill its children on Windows, and a Unix child that
//! forks its own descendants outlives a plain `kill` on the direct child. A desktop
//! app that supervises a long-running Node server therefore leaks orphan processes
//! on every crash unless the OS is told to reclaim the tree. This crate wires up
//! that reclamation:
//!
//! - **Windows** — a Job Object carrying `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The
//!   kernel terminates every process in the job once the last handle to it closes,
//!   which happens even when the parent dies to `TerminateProcess` and runs no
//!   cleanup code of its own.
//! - **Unix** — each child leads its own process group, so the whole group is
//!   reachable through `killpg`.
//!
//! On Windows children additionally start with `CREATE_NO_WINDOW`. That gives the
//! child a console with no visible window, and grandchildren inherit it — so
//! command-line tools the supervised process spawns stay invisible as well.

use std::io;

#[cfg_attr(windows, path = "windows.rs")]
#[cfg_attr(unix, path = "unix.rs")]
mod platform;

/// Owns a set of child process trees and reclaims them when dropped.
///
/// One guard can own many children. Dropping it terminates all of them.
pub struct ProcessGuard {
    inner: platform::Inner,
}

impl ProcessGuard {
    /// Create a guard holding no children yet.
    pub fn new() -> io::Result<Self> {
        Ok(Self {
            inner: platform::Inner::new()?,
        })
    }

    /// Spawn `command` as a guarded child.
    ///
    /// The child is placed under this guard before it executes a single
    /// instruction, so descendants it spawns cannot escape the guard.
    pub fn spawn(
        &self,
        command: &mut tokio::process::Command,
    ) -> io::Result<tokio::process::Child> {
        self.inner.spawn(command)
    }

    /// Put an already-running process tree under this guard.
    ///
    /// For trees this crate did not start. A pty child is the case that needs it:
    /// the pty layer has to create the process itself, because the pseudoconsole
    /// has to be attached through a process-creation attribute that only the
    /// caller of `CreateProcess` can set. Pass the root of the tree.
    ///
    /// Weaker than [`ProcessGuard::spawn`] on Windows by exactly one gap. `spawn`
    /// starts the child suspended, so it cannot have spawned anything before it
    /// joins the job; an adopted child has been running for however long it took
    /// to get here, and a descendant it started inside that window is outside the
    /// job and will not be reclaimed. Microseconds for a shell that has yet to
    /// print a prompt, but not zero, and there is no way to close it from out
    /// here — the suspension would have to happen at creation.
    ///
    /// On Unix `pid` is taken to be a process-group leader's, which is what a pty
    /// child is: the pty layer calls `setsid` before `exec`, so the child leads a
    /// new session and its pgid equals its pid. Adopting a process that is *not*
    /// a group leader records a group that does not exist, and nothing is
    /// reclaimed.
    pub fn adopt(&self, pid: u32) -> io::Result<()> {
        self.inner.adopt(pid)
    }

    /// Terminate every process still running under this guard.
    ///
    /// Callers that want a graceful shutdown should signal the child and wait
    /// first; this is the escalation path.
    pub fn terminate_all(&self) -> io::Result<()> {
        self.inner.terminate_all()
    }
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        let _ = self.inner.terminate_all();
    }
}

/// Keep a short-lived command from flashing a console window on Windows.
///
/// Use this for one-shot probes such as `node --version`. Long-running trees
/// should go through [`ProcessGuard::spawn`], which applies the same flag and
/// adds reclamation on top.
pub fn hide_console(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

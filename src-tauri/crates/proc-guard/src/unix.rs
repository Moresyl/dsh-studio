//! Unix backend: every child leads its own process group.
//!
//! A process group is the portable way to reach a whole tree with one signal.
//! There is no `KILL_ON_JOB_CLOSE` equivalent, so the groups are recorded and
//! signalled explicitly when the guard is dropped.

use std::io;
use std::os::unix::process::CommandExt;
use std::sync::Mutex;

pub(crate) struct Inner {
    /// Process-group ids, which equal the pid of each group leader.
    groups: Mutex<Vec<i32>>,
}

impl Inner {
    pub(crate) fn new() -> io::Result<Self> {
        Ok(Self {
            groups: Mutex::new(Vec::new()),
        })
    }

    pub(crate) fn spawn(
        &self,
        command: &mut tokio::process::Command,
    ) -> io::Result<tokio::process::Child> {
        // `0` makes the child its own group leader, so its pgid equals its pid.
        // Applied pre-exec by the standard library, which leaves no race.
        command.as_std_mut().process_group(0);

        let child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("guarded child exited before it could be adopted"))?;

        self.groups
            .lock()
            .expect("proc-guard group list poisoned")
            .push(pid as i32);

        Ok(child)
    }

    pub(crate) fn adopt(&self, pid: u32) -> io::Result<()> {
        // Nothing to arrange: the caller's pid *is* the group id, so recording it
        // is the whole of the work. `spawn` differs only in that it arranges that
        // fact itself instead of being told it.
        self.groups
            .lock()
            .expect("proc-guard group list poisoned")
            .push(pid as i32);
        Ok(())
    }

    pub(crate) fn terminate_all(&self) -> io::Result<()> {
        let groups =
            std::mem::take(&mut *self.groups.lock().expect("proc-guard group list poisoned"));

        for pgid in groups {
            // ESRCH just means the group already exited, which is the goal state.
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
        Ok(())
    }
}

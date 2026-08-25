//! Unix backend: every child leads its own process group.
//!
//! A process group is the portable way to reach a whole tree with one signal.
//! There is no `KILL_ON_JOB_CLOSE` equivalent, so the groups are recorded and
//! signalled explicitly when the guard is dropped.

use std::io;
use std::os::unix::process::CommandExt;
use std::sync::{Mutex, MutexGuard, PoisonError};

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

        self.register(process_group(pid)?);

        Ok(child)
    }

    pub(crate) fn adopt(&self, pid: u32) -> io::Result<()> {
        let pgid = process_group(pid)?;
        let actual = unsafe { libc::getpgid(pgid) };
        if actual < 0 {
            return Err(io::Error::last_os_error());
        }
        if actual != pgid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("process {pid} is not the leader of process group {actual}"),
            ));
        }
        self.register(pgid);
        Ok(())
    }

    pub(crate) fn terminate_all(&self) -> io::Result<()> {
        // Do not forget a group before the signal succeeds. A permission error
        // is unusual, but retaining that pgid lets Drop or a later explicit
        // cleanup retry instead of silently declaring the tree reclaimed.
        let groups = self.groups().clone();
        let mut terminated = Vec::with_capacity(groups.len());
        let mut first_failure = None;
        for pgid in groups {
            match kill_group(pgid) {
                Ok(()) => terminated.push(pgid),
                Err(failure) if first_failure.is_none() => first_failure = Some(failure),
                Err(_) => {}
            }
        }
        self.groups()
            .retain(|candidate| !terminated.contains(candidate));

        first_failure.map_or(Ok(()), Err)
    }

    pub(crate) fn finish(&self, pid: u32) -> io::Result<()> {
        let pgid = process_group(pid)?;
        kill_group(pgid)?;
        self.groups().retain(|candidate| *candidate != pgid);
        Ok(())
    }

    /// Group ids are append-only bookkeeping; recover it after an unwind so
    /// process cleanup never becomes the next panic in the chain.
    fn groups(&self) -> MutexGuard<'_, Vec<i32>> {
        self.groups.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn register(&self, pgid: i32) {
        let mut groups = self.groups();
        if !groups.contains(&pgid) {
            groups.push(pgid);
        }
    }
}

fn process_group(pid: u32) -> io::Result<i32> {
    let pgid = i32::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid exceeds Unix pid_t"))?;
    if pgid == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pid zero does not identify a process group",
        ));
    }
    Ok(pgid)
}

fn kill_group(pgid: i32) -> io::Result<()> {
    let killed = unsafe { libc::killpg(pgid, libc::SIGKILL) };
    if killed == 0 {
        return Ok(());
    }

    let failure = io::Error::last_os_error();
    // The whole group already being gone is the desired end state.
    if failure.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(failure)
    }
}

#[cfg(test)]
mod tests {
    use std::panic::{self, AssertUnwindSafe};

    use super::Inner;

    #[test]
    fn poisoned_group_bookkeeping_remains_recoverable() {
        let guard = Inner::new().expect("guard");
        let _ = panic::catch_unwind(AssertUnwindSafe(|| {
            let _held = guard.groups.lock().expect("initial lock");
            panic!("poison process group bookkeeping");
        }));

        guard.groups().push(1234);
        assert_eq!(&*guard.groups(), &[1234]);
    }

    #[test]
    fn invalid_process_ids_never_become_signal_targets() {
        let guard = Inner::new().expect("guard");
        assert_eq!(
            guard.adopt(0).expect_err("zero must be rejected").kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert_eq!(
            guard
                .finish(u32::MAX)
                .expect_err("overflow must be rejected")
                .kind(),
            std::io::ErrorKind::InvalidInput
        );
        assert!(guard.groups().is_empty());
    }
}

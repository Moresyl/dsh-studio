//! What the guard promises, checked against a real process tree.
//!
//! The interesting subject is the *grandchild*. Killing a supervised Node server
//! is easy; the bug that strands users is the shell command it spawned, which
//! survives its parent and keeps holding a port or a file lock. So the fixture
//! here is deliberately two levels deep: the guarded child does nothing but run
//! another process, and it is that inner process whose death is asserted.
//!
//! Liveness is observed through a file the inner process appends to on a timer,
//! because a PID is not evidence — the number is reused, and a process can be a
//! zombie while its PID still resolves. A file that stops growing is evidence.

use std::fs;
#[cfg(not(windows))]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use proc_guard::ProcessGuard;
use tokio::process::Command;

/// Generous: a cold `cmd`/`sh` on a loaded CI box is not fast.
const STARTUP_GRACE: Duration = Duration::from_secs(15);

/// Longer than the fixture's tick, so "no growth" means stopped, not "between ticks".
const SETTLE: Duration = Duration::from_secs(3);

#[tokio::test]
async fn a_guarded_child_actually_runs() {
    // Guarded children are created suspended and resumed by walking the system
    // thread list. If that walk ever misses, the child hangs forever holding no
    // clue as to why — so the first thing to prove is that it runs at all.
    let guard = ProcessGuard::new().expect("create guard");

    let mut command = shell(&["echo guarded"]);
    command.stdout(std::process::Stdio::piped());
    let child = guard.spawn(&mut command).expect("spawn");

    let done = tokio::time::timeout(STARTUP_GRACE, child.wait_with_output())
        .await
        .expect("child produced no output before the deadline")
        .expect("collect output");

    assert!(done.status.success(), "child failed: {:?}", done.status);
    assert_eq!(String::from_utf8_lossy(&done.stdout).trim(), "guarded");
}

#[tokio::test]
async fn terminate_all_ends_a_running_child() {
    let guard = ProcessGuard::new().expect("create guard");
    let mut child = guard.spawn(&mut sleeper()).expect("spawn");

    assert!(
        child.try_wait().expect("poll child").is_none(),
        "the fixture was supposed to outlive this test"
    );

    guard.terminate_all().expect("terminate");

    tokio::time::timeout(STARTUP_GRACE, child.wait())
        .await
        .expect("child outlived terminate_all")
        .expect("wait");
}

/// The one that matters: a process two levels down dies with the guard.
///
/// This exercises `Drop`, which terminates explicitly. The stronger guarantee —
/// the kernel reclaiming the tree when the *shell itself* is killed and runs no
/// cleanup — is a `KILL_ON_JOB_CLOSE` property that cannot be observed from
/// inside the process that would have to die for it to apply.
#[tokio::test]
async fn dropping_the_guard_ends_a_grandchild() {
    let workspace = scratch_dir("grandchild");
    let ticks = workspace.join("ticks.log");
    let outer = write_tree_fixture(&workspace, &ticks);

    let guard = ProcessGuard::new().expect("create guard");
    let _child = guard
        .spawn(&mut shell(&[&outer.to_string_lossy()]))
        .expect("spawn");

    let alive = wait_until_growing(&ticks).await;
    assert!(alive > 0, "the grandchild never started ticking");

    drop(guard);

    // First settle absorbs a tick already in flight when the job was terminated.
    tokio::time::sleep(SETTLE).await;
    let after_drop = size_of(&ticks);
    tokio::time::sleep(SETTLE).await;

    assert_eq!(
        size_of(&ticks),
        after_drop,
        "the grandchild kept running after its guard was dropped"
    );

    let _ = fs::remove_dir_all(&workspace);
}

/// The same guarantee for a tree the guard did not start.
///
/// `adopt` exists for pty children, which the pty layer must create itself. The
/// stand-in here is a plainly spawned shell — same situation from the guard's
/// point of view: a pid that was already running when it was handed over.
#[tokio::test]
async fn dropping_the_guard_ends_an_adopted_grandchild() {
    let workspace = scratch_dir("adopted");
    let ticks = workspace.join("ticks.log");
    let outer = write_tree_fixture(&workspace, &ticks);

    let mut command = shell(&[&outer.to_string_lossy()]);
    // What a pty child gets from `setsid`, arranged by hand: `adopt` reclaims a
    // process group on Unix, and a child left in this test's own group is not one.
    #[cfg(not(windows))]
    command.as_std_mut().process_group(0);

    let mut child = command.spawn().expect("spawn unguarded");
    let pid = child.id().expect("the fixture exited immediately");

    let guard = ProcessGuard::new().expect("create guard");
    guard.adopt(pid).expect("adopt");

    let alive = wait_until_growing(&ticks).await;
    assert!(alive > 0, "the grandchild never started ticking");

    drop(guard);

    tokio::time::sleep(SETTLE).await;
    let after_drop = size_of(&ticks);
    tokio::time::sleep(SETTLE).await;

    assert_eq!(
        size_of(&ticks),
        after_drop,
        "the grandchild kept running after the guard that adopted it was dropped"
    );

    // Nothing waits on an unguarded child, so reap it before the temp files go.
    let _ = child.start_kill();
    let _ = child.wait().await;
    let _ = fs::remove_dir_all(&workspace);
}

/// Wait for the fixture to prove it is alive, returning the size it reached.
async fn wait_until_growing(ticks: &Path) -> u64 {
    let deadline = Instant::now() + STARTUP_GRACE;
    while Instant::now() < deadline {
        let size = size_of(ticks);
        if size > 0 {
            return size;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    0
}

fn size_of(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

/// A command that runs `arguments` through the platform's command interpreter.
fn shell(arguments: &[&str]) -> Command {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.arg("/c");
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("sh");
        command.arg("-c");
        command
    };

    #[cfg(windows)]
    command.args(arguments);
    // `sh -c` takes one string, so several arguments have to be joined.
    #[cfg(not(windows))]
    command.arg(arguments.join(" "));

    command
}

/// A process that stays alive well past the end of the test.
fn sleeper() -> Command {
    #[cfg(windows)]
    // `ping` to loopback is the sleep that is always installed on Windows.
    return shell(&["ping -n 600 127.0.0.1 >nul"]);
    #[cfg(not(windows))]
    return shell(&["sleep 600"]);
}

/// Write a two-level fixture and return the entry point.
///
/// The outer script's only job is to run the inner one and wait, so the process
/// doing the observable work is a grandchild of this test.
fn write_tree_fixture(workspace: &Path, ticks: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let inner = workspace.join("inner.cmd");
        let outer = workspace.join("outer.cmd");
        fs::write(
            &inner,
            format!(
                "@echo off\r\n\
                 for /l %%i in (1,1,100000) do (\r\n\
                 echo tick>>\"{ticks}\"\r\n\
                 ping -n 2 127.0.0.1 >nul\r\n\
                 )\r\n",
                ticks = ticks.display()
            ),
        )
        .expect("write inner fixture");
        fs::write(
            &outer,
            format!("@echo off\r\ncmd /c \"{}\"\r\n", inner.display()),
        )
        .expect("write outer fixture");
        outer
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;

        let inner = workspace.join("inner.sh");
        let outer = workspace.join("outer.sh");
        fs::write(
            &inner,
            format!(
                "#!/bin/sh\nwhile :; do echo tick >> \"{ticks}\"; sleep 1; done\n",
                ticks = ticks.display()
            ),
        )
        .expect("write inner fixture");
        // The trailing `wait` keeps `sh` from exec-ing the inner script in place,
        // which would collapse the two levels this fixture exists to create.
        fs::write(
            &outer,
            format!("#!/bin/sh\nsh \"{}\" &\nwait\n", inner.display()),
        )
        .expect("write outer fixture");
        fs::set_permissions(&outer, fs::Permissions::from_mode(0o700))
            .expect("make outer fixture executable");
        outer
    }
}

/// A private directory under the system temp, unique to this run.
fn scratch_dir(purpose: &str) -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let unique = NEXT.fetch_add(1, Ordering::Relaxed);

    let path = std::env::temp_dir().join(format!(
        "proc-guard-{purpose}-{}-{unique}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create scratch directory");
    path
}

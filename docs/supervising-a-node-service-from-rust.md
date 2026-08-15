# Supervising a Node service from a Rust desktop app

> Authorship disclosure: this article was written with OpenAI Codex from DSH
> Studio's implementation, tests, and release notes. The linked source is the
> authority for every behavioral claim below.

DSH Studio is a Tauri 2 desktop host for DeepSeek Harness, whose user interface
is normally served by a local Node process. The interesting part is not spawning
`node`; it is making a web service behave like a desktop-owned resource across
Windows, macOS, and Linux.

Version 0.1.1 turns that lifecycle into a small Rust state machine. This note
explains four decisions behind it: letting the child choose its port, separating
readiness from health, restarting through one backoff path, and assigning the
entire descendant tree to an operating-system lifetime primitive.

## Let the kernel choose the port

Scanning for an unused port and then launching a server on it contains a race:
another process can bind between the scan and the child's `bind`. DSH Studio
instead launches the harness with `--port 0`. The kernel selects an ephemeral
port atomically, and the harness announces the address on stdout:

```text
dsh web: http://127.0.0.1:52175
```

The Rust side reads both output streams asynchronously but only treats stdout as
a readiness channel. The parser accepts `http`, an explicit port, and a
loopback host. An announcement for another host or scheme becomes a startup
failure rather than a WebView navigation. Ordinary log lines remain ordinary
log lines.

The first matching line completes a Tokio `oneshot` channel. Startup races that
channel against both `child.wait()` and a 120-second timeout (simplified below):

```rust
let outcome = tokio::select! {
    announced = ready_rx => parse_announcement(announced),
    exit = child.wait() => startup_exit(exit),
    _ = tokio::time::sleep(READINESS_TIMEOUT) => startup_timeout(),
};
```

This creates three explicit outcomes instead of leaving the UI stuck on
“starting”: the service became ready, exited before readiness, or never
announced readiness.

## A live PID is not a healthy service

Waiting on the child detects a crash, but not a wedged event loop. A TCP connect
is also insufficient: the kernel can complete a handshake from the listen
backlog even when the process no longer accepts or services requests.

The supervisor therefore performs a small HTTP exchange every ten seconds. It
writes a `HEAD /` request directly to a Tokio `TcpStream` and reads the first 12
bytes of the status line. Any HTTP status is healthy—the question is whether the
service can still answer, not whether `/` returns 200.

A probe has a five-second budget. One miss is logged, while three consecutive
misses mark the child as wedged. A successful probe resets the counter. Tests
cover a 404 response, non-HTTP data, a refused connection, and the important
case where a listener accepts TCP connections but never sends a byte.

## One recovery path for crashes and hangs

Health monitoring does not restart the service directly. When it detects a
wedged child, it kills that child and returns through the same path used for an
unexpected process exit. Both failures then consume the same bounded backoff
schedule:

```rust
const RESTART_DELAYS_MS: [u64; 5] = [500, 1_000, 2_000, 5_000, 10_000];
```

Each attempt must pass the full readiness procedure again. A successful restart
publishes the new origin and PID to the React shell; exhausting the schedule
publishes a terminal failure. Keeping one recovery path avoids a subtle class
of bugs where crash recovery and health recovery disagree about status,
readiness, or which port the WebView should load.

The public `start` operation is idempotent once ready and rejects concurrent
starts while another launch owns the child. An intentional stop sets an atomic
flag before terminating processes, so the supervision loop cannot mistake the
resulting exit for a crash and revive it.

## Own the process tree, not only the direct child

An agent harness launches tools, and those tools can launch more processes.
Killing only the `node` handle does not reliably reclaim its descendants.

DSH Studio isolates this platform behavior in the small `proc-guard` crate. On
Windows, children are assigned to a Job Object configured with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; the kernel terminates the job when its
owner disappears. On Unix, children enter their own process group and shutdown
signals the group. The same guard also owns temporary installer processes.

That arrangement matters most during abnormal exit. Cleanup does not depend on
the Tauri event loop receiving a final callback, so killing the desktop process
does not turn its tool subprocesses into orphans.

## Keeping the boundary reusable

The supervisor is specific to DeepSeek Harness because it knows the launch
arguments and readiness line. Port selection, HTTP liveness, and process-tree
ownership are not. Keeping process ownership in `proc-guard` and Node discovery
in a separate `node-runtime` crate leaves the Tauri-facing code responsible only
for lifecycle state and UI events.

The complete implementation and tests are in
[`src-tauri/src/harness`](../src-tauri/src/harness) and
[`src-tauri/crates`](../src-tauri/crates). Version 0.1.1 packages the result for
Windows, Linux, macOS Intel, and macOS Apple Silicon.

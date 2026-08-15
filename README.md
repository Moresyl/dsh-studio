<div align="center">

<img src="assets/brand/icon.svg" width="76" alt="">

# DSH Studio

**A native desktop shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Rust + Tauri 2. It supervises the local `dsh` service, reclaims every process it
spawns, and never forks the upstream project to do it.

[English](README.md) · [简体中文](README.zh-CN.md)

<img src="assets/screenshot-launcher.png" width="760" alt="DSH Studio launcher">

</div>

---

## Why this exists

`dsh` is a local web service. Running it from a terminal works, but it leaves you
managing a process by hand: finding a free port, noticing when it dies, and
cleaning up the tool subprocesses it leaves behind when it does.

DSH Studio makes that a window. The design goal is that the shell should be
**boring** — it starts the service, keeps it alive, and stays out of the way of
the harness UI.

## What it does

**Supervises, rather than just launches.**
The service runs under a supervisor that restarts it with backoff when it exits.
A restart lands on a new port and the window follows it — no stale bookmarks, no
manual re-launch.

**Notices a service that is alive but wedged.**
Watching the process is only half the job: a server that has stopped answering
still has a live PID, and a TCP connect still succeeds because the kernel
completes the handshake from the listen backlog. So the supervisor sends a real
HTTP request every 10 seconds. Three consecutive misses and the harness is
recycled.

**Reclaims the whole process tree.**
The harness spawns tools, which spawn their own children. On Windows the service
is launched into a [Job Object] with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the
kernel tears the tree down even if the shell is killed outright. On Unix it gets
its own process group and is signalled as a group. Closing the window leaves
nothing behind.

**Picks its own port.**
`--port 0` asks the OS for an unused one and the supervisor reads back the port
the service actually bound. There is no configured port to collide with, and no
scan-for-a-free-port race between the check and the bind.

**Installs the harness for you.**
If `@deepseek-ai/dsh` is not on the machine, the row that says so is a button.
It runs `npm install` against a private prefix inside the app's data directory —
invoking `npm-cli.js` through the detected Node binary directly, never through a
shell — and streams the output into the window while it works.

**Hosts the harness instead of replacing it.**
The harness UI is loaded in a frame under the shell's own title bar, so the
window stays movable and closable, and switching to the control panel does not
throw away a running session. Nothing about the upstream project is patched or
vendored.

[Job Object]: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects

<div align="center">
<img src="assets/screenshot-harness.png" width="760" alt="The harness running inside DSH Studio">
</div>

## Status

Early. The Windows path is built and verified end to end; the rest is honest
about being unfinished.

| | |
|---|---|
| Environment detection, one-click install | ✅ |
| Supervisor, backoff restart, health probing | ✅ |
| Process-tree reclamation (Windows / Unix) | ✅ |
| Harness hosting, log console, English + 中文 | ✅ |
| Verified on Windows 11 | ✅ |
| macOS / Linux rendering | ⏳ not yet run |
| Bundled Node runtime (no system Node needed) | ⏳ planned |
| Tray icon, native menus, auto-update | ⏳ planned |
| Packaged releases | ⏳ not yet published |

## Requirements

- **Node.js 20 or newer.** DSH Studio detects it rather than bundling it, for
  now — see the roadmap above. The harness itself is installed for you.
- Windows 10/11 with WebView2 (present on Windows 11 by default).

## Building from source

```sh
pnpm install
pnpm tauri dev      # run it
pnpm tauri build    # produce installers for the current platform
```

Checks:

```sh
pnpm lint                                          # ESLint, zero warnings
pnpm exec tsc --noEmit                             # strict TypeScript
pnpm test                                          # store and i18n behaviour
cargo test --manifest-path src-tauri/Cargo.toml --workspace
```

## Layout

```
src/                       React 19 + Tailwind 4 shell UI
src-tauri/src/harness/     supervisor, readiness parsing, health probe, install
src-tauri/crates/
  node-runtime/            find a usable Node on this machine
  proc-guard/              kill a process tree and mean it
```

`node-runtime` and `proc-guard` are deliberately free of Tauri and of anything
specific to this app — they are two small crates that answer two questions any
desktop app wrapping a Node service has to answer.

## Contributing

Issues and pull requests are welcome. The one house rule is in the code style:
comments explain *why* a thing is the way it is, not what the line below does.

## License

[MIT](LICENSE).

DSH Studio is an independent project. It is not affiliated with or endorsed by
DeepSeek.

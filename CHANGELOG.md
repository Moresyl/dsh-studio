# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the usual
pre-1.0 caveat that anything may still move.

[简体中文](CHANGELOG.zh-CN.md)

## [Unreleased]

### Fixed

- The Unix process-tree test wrote its fixture script without an executable
  bit, so the case that proves `proc-guard` reclaims grandchildren could not
  run on Linux or macOS.

### Documentation

- `CONTRIBUTING.md`, `SECURITY.md`, this changelog, and GitHub issue and pull
  request templates, each with a Chinese counterpart.
- README gained an architecture diagram, the startup sequence step by step, an
  install table of the four release targets, a comparison with the other
  desktop app for the harness, and an FAQ.

## [0.1.1] — 2026-08-15

### Fixed

- `@types/node` was missing from `devDependencies`, so `tsc --noEmit` — and
  therefore `pnpm build` and the release pipeline — failed on a clean checkout
  even though it passed locally. No change to what the application does.

## [0.1.0] — 2026-08-15

First release. Verified end to end on Windows 11; macOS and Linux are built by
CI but have not been run by a human yet.

### Added

- **Node detection.** Every Node on the machine is probed with `--version`,
  including installs a version manager made but never put on `PATH`. The newest
  one meeting the minimum wins, and two directories reporting the same version
  are ordered by path so the choice is the same on every launch.
- **One-click install.** When `@deepseek-ai/dsh` is missing, the row that says
  so is a button. It installs into a private prefix inside the app's data
  directory, invoking `npm-cli.js` through the detected Node binary directly and
  never through a shell, and streams the output into the window.
- **Supervisor.** The service runs under a supervisor that restarts it with
  backoff after an exit.
- **Kernel-assigned port.** The service is launched with `--port 0` and the
  supervisor reads the port it actually bound out of the readiness line. No
  configured port to collide with, and no gap between checking a port and
  binding it.
- **Health probing.** A real HTTP request every 10 seconds, because a wedged
  server still has a live PID and still accepts TCP connections from the listen
  backlog. Three consecutive misses recycle it.
- **Process-tree reclamation.** On Windows the service goes into a Job Object
  with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so the kernel tears the tree down
  even if the shell is killed outright. On Unix it gets its own process group
  and is signalled as a group.
- **Harness hosting.** The upstream UI is loaded in a frame from its own origin
  under the shell's title bar. Switching to the control panel does not discard a
  running session, and nothing upstream is patched or vendored.
- **Log console.** The shell's own output, selectable and copyable.
- **English and 简体中文,** picked up from the system locale.
- **Tray icon** with an open/quit menu, and close-to-tray while the service is
  running so closing the window does not end a session by accident.
- **Desktop-shaped window** — custom title bar with minimise, maximise and
  close, and a status bar along the bottom carrying what the harness is doing,
  the address it serves on, the Node it chose, and the workspace. The address
  opens in a browser on click and copies on right-click; the workspace opens in
  the file manager.
- **Release pipeline.** A tagged version is built by CI for Windows x64, Linux
  x64, macOS Apple Silicon and macOS Intel.

[Unreleased]: https://github.com/Moresyl/dsh-studio/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Moresyl/dsh-studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Moresyl/dsh-studio/releases/tag/v0.1.0

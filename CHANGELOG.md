# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the usual
pre-1.0 caveat that anything may still move.

[简体中文](CHANGELOG.zh-CN.md)

## [Unreleased]

### Added

- **A new release announces itself.** The window asks the release feed a few
  seconds after launch and every six hours after that, and a published version
  newer than the running one appears as a notice in the bottom-left corner: one
  line, a click to read the release, and a dismiss button. Dismissal is per
  version and survives a restart, so saying "not now" to 0.3.0 stays said until
  0.4.0 exists. Nothing is downloaded and nothing is installed. The About item
  in the nav rail also carries a dot for as long as the newer version is
  available, so the notice is not the only way back to it.

- **The window opens where you left it.** Position, size, and whether it was
  maximised are written a moment after you stop dragging, and restored while the
  window is still hidden — so it is never seen in the centre of the screen first
  and then jumping. A position saved on a monitor that is no longer attached is
  ignored rather than restored somewhere you cannot reach.

- **Right-click menus, everywhere there is something to do.** The log console
  offers copy, copy everything, and clear; the service address offers open and
  copy; the process id, the workspace, the Node path, and each path in About
  offer copy and reveal; and the title bar answers with the window menu that
  disappeared along with the system's decorations — minimise, maximise, close.
  They are drawn by the app rather than handed to the system: a Win32 menu
  arrives in the desktop's theme and visibly belongs to another program. They
  open under the pointer, flip at the window's edge, follow the arrow keys,
  close on Escape, and the click that dismisses one does not also press what was
  underneath it.

- **A question before anything is removed.** Removing a plugin now asks first,
  in a panel the app drew — not the webview's `confirm()` box, which arrives in
  the browser's shape with the page's address printed above its buttons and is
  the loudest thing in a desktop window that says "this is a web page". Enter
  answers it, Escape and the dimmed area behind it say no, Tab stays inside, and
  the caret goes back where it was.

- **Ctrl+1 to Ctrl+4** switch to console, plugins, remote, and about — and bring
  the panel forward if the harness was covering it, because a shortcut that
  changes something you cannot see is worse than no shortcut. Each rail button
  names its own key on hover (⌘ on macOS).

### Changed

- **The browser's reflexes are gone.** F5 no longer throws the application away
  and rebuilds it, Ctrl+P no longer offers to print the window, Ctrl+scroll no
  longer rescales the whole interface, a dropped file no longer replaces the app
  with whatever was dropped, and Ctrl+F, Ctrl+S, Ctrl+U and the rest now do what
  they do in every other desktop program: nothing. Inside a text field the
  shortcuts that belong to text still work.
- Selected text is tinted with the app's own accent instead of the system blue,
  and buttons and icons can no longer be dragged out of the window as images.
- The registry search field lost the browser's own clear button — grey,
  undersized, and the only control in the window this app did not draw — and
  gained one that matches the rest of it. Escape empties the field without
  taking the caret out of it.
- **The service address left the status bar.** A desktop application that prints
  `127.0.0.1:52418` along its bottom edge is telling on itself. The address is a
  fact about the plumbing, so it now lives only in the console's service
  section, where it still opens in a browser on click and copies on right-click.
- The update check is shared between the status bar and the About pane rather
  than run twice, and a failed check no longer writes to the harness log — a
  laptop on a train is not an event worth reporting.

## [0.2.0] — 2026-08-16

Two features that change what the shell is for: it now extends the harness, and
it can hand it to your phone.

### Added

- **Plugin marketplace.** Search the npm registry from inside the window, read
  what a package declares — version, license, dependencies, and whether it
  carries a profile patch at all — and install it into the harness's hosted
  profile. Installs and removals go through the harness's own plugin command
  rather than editing its files behind its back, so the result is exactly what
  the harness would have produced itself. A package with no profile patch is
  labelled the library it is instead of appearing as a plugin that silently did
  nothing, and one that came with the profile template is shown as built in and
  cannot be removed from here.
- **Remote access from a phone.** Off until you open it, and opening it does not
  move the service: `dsh` stays on loopback. What opens is a separate gateway
  bound to one chosen LAN address, holding a 128-bit token minted for that
  session and never written to disk or into a log. Pairing is a QR code the Rust
  side encodes — scan it, the token is exchanged for a cookie, and everything
  after that is spliced straight through to the harness. The pane reports how
  many connections are live, how many it has served, and how many it refused.
  Closing the door, or the harness stopping, invalidates the token; the next
  session mints a different one.
- **Update check.** The About pane asks the release feed what the newest
  published version is and says whether it is newer than what is running.
  Nothing is downloaded and nothing is installed — the answer is a link.
- **About pane.** Version, platform and architecture, and the three directories
  the app actually uses, each of which opens in the file manager.
- **A workbench instead of a single panel.** The control panel became four
  views — Console, Plugins, Remote, About — behind a navigation rail that
  carries live state: a dot when remote access is open, a count of what is
  installed. Views keep their state while the harness is on screen, so a typed
  search and a pairing code on display survive a glance at the harness.

### Fixed

- The Unix process-tree test wrote its fixture script without an executable
  bit, so the case that proves `proc-guard` reclaims grandchildren could not
  run on Linux or macOS.

### Documentation

- `CONTRIBUTING.md`, `SECURITY.md`, this changelog, and GitHub issue and pull
  request templates, each with a Chinese counterpart.
- README gained an architecture diagram, the startup sequence step by step, an
  install table of the four release targets, the design decisions and what each
  one gives up, and an FAQ.
- `SECURITY.md` states what the remote gateway guarantees — off by default, one
  bound address, no forwarding without the session token, and no token on disk —
  so that a report about any of them has something to be measured against.

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

[Unreleased]: https://github.com/Moresyl/dsh-studio/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Moresyl/dsh-studio/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Moresyl/dsh-studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Moresyl/dsh-studio/releases/tag/v0.1.0

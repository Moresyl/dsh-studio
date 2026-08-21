# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the usual
pre-1.0 caveat that anything may still move.

[简体中文](CHANGELOG.zh-CN.md)

## [Unreleased]

## [0.7.0] — 2026-08-22

### Added

- Bounded diagnostic ZIP export, Rust/WebView crash evidence, native Windows
  minidumps, a persistent log-level setting, and 10 MiB file / seven-day /
  200 MiB directory log retention.
- A Full / Offline edition that carries SHA-256-pinned Node, Harness and pnpm
  payloads, plus a Windows Lite portable executable and a macOS Universal Lite
  image.
- Native workspace folder selection and drop that create/open real upstream
  Harness workspaces, independently configurable turn and background-job
  notifications, and persistent Compatibility/Advanced presentation modes.
- A paged, filtered and sorted plugin catalog index with durable market receipts
  for exact source, version and registry integrity, plus restricted catalog
  images, a two-phase native install review, and a rate-limited reviewed
  dshfind adapter that accepts only verified stable npm targets.
- Protocol 3 desktop profile/plugin/workspace services, a pinned terminal
  toolchain, and a managed Harness client integration; packaged macOS/Linux
  launches recover an allowlisted login-shell environment.

### Changed

- Lite and Full now share one immutable runtime lock committed to the repository.
  Every package version, registry URL and integrity value comes from the same
  contract, so online first-run and offline payloads no longer solve separately.
- Packaged applications must execute a smoke test before publication, Windows
  installers must pass an upgrade regression, and release verification now
  requires the portable and Universal artifacts.
- Profile startup validates the selected profile before launch and offers one
  guarded recovery center for last-known-good fallback, exact faulty-plugin
  isolation, retry and bounded diagnostic export.
- Desktop services revalidate exact versions and catalog membership at the
  native boundary. Market installs additionally block lifecycle scripts,
  deprecated packages, weak integrity and mismatched repository backlinks; the
  bridge remains restricted to the active loopback Harness origin.
- CI enforces at least 80% statements, branches, functions and lines for the
  deterministic browser logic, and at least 80% line coverage for every listed
  critical Rust safety module, including the LAN gateway.

### Fixed

- Fixed the floating rc.8 transitive graph resolving to the unpublished
  `@aws-sdk/core@^3.977.9` after upstream publication and failing Lite first-run
  with `ETARGET`. Installation now accepts only the execution-qualified lock
  while retaining exact Harness and pnpm versions.
- A damaged or deleted selected profile no longer strands startup in a repeated
  failure loop; Studio can restore the last known good profile or disable the
  plugin implicated by the failed launch.
- Packaged GUI launches on macOS/Linux no longer lose development tool paths
  configured by supported login shells, while credential variables remain
  excluded.
- Installer upgrades preserve application data and can launch the upgraded
  binary; background completion/failure no longer goes unnoticed when the
  Studio window is not focused.
- Full / Offline archives no longer let Windows `tar` interpret an absolute
  drive path as a remote host or retain a broken local Studio integration link;
  extraction and creation use local archive filenames, the complete integration
  package is now materialized in every payload, and Linux smoke tests retain the
  absolute AppImage path while explicitly piping `rpm2cpio` into `cpio`. Windows
  ZIP extraction uses the system bsdtar rather than Git Bash's incompatible GNU
  tar.
- Catalog media can no longer make the renderer fetch arbitrary remote URLs;
  admitted images are bounded, decoded and re-encoded locally before display.

## [0.6.0] — 2026-08-21

### Added

- A secure multi-source plugin catalog with npm, a reviewed 1024Store adapter,
  and user-managed Schema 1.0.0 HTTPS endpoints. Catalogs can suggest only an
  exact npm target; SSRF destinations, cross-origin redirects, executable
  commands, oversized replies and malformed metadata are rejected.
- Durable plugin-mutation recovery, persistent redacted logs, panic evidence,
  and diagnostics that report recovery and runtime compatibility.
- Windows workspace admission checks for fixed NTFS/ReFS volumes, blocking
  network, removable and FAT/exFAT workspaces before Harness starts.
- Bilingual user, troubleshooting, architecture, plugin/catalog and community
  documentation.

### Changed

- The managed upstream runtime is pinned to `@deepseek-ai/dsh@0.1.0-rc.8`,
  pnpm is pinned to 11.7.0, and Node 22.19 is the minimum coherent runtime.
- Harness installs now use a journaled staging/backup transaction and repair an
  interrupted or incompatible managed runtime instead of launching it silently.
- Formal releases now fail closed on updater signing, bilingual detailed notes,
  and the complete non-empty artifact matrix. Windows Authenticode and macOS
  Developer ID signing/notarization/stapling are applied when the corresponding
  credentials are configured; partial credential sets are rejected.

### Fixed

- Replaced the obsolete rc.1 dependency graph that requested the unpublished
  `@deepseek-ai/dsh-code-runtime-worker` package and surfaced misleading npm
  mirror/authentication errors during plugin installation.
- Plugin add/remove/import operations no longer leave half-written profile and
  package state after a crash or forced shutdown.

## [0.5.0] — 2026-08-18

This release turns the shell into a fuller desktop workspace: guided setup,
built-in terminals, multiple profiles, searchable session history and usage
reports, command-driven navigation, parallel windows, offline plugins, and a
distribution path that can bootstrap its own Node runtime.

### Added

- **The shell brings its own Node when the machine has none.** A machine without
  Node used to get pointed at nodejs.org and asked to come back, which is where
  most people stop. The Node row is now a button: it reads the current LTS from
  the official release index rather than pinning a version, downloads that build,
  checks it against the published SHA-256 _before_ unpacking, and only calls it
  installed once the unpacked binary answers `--version` — which also catches a
  glibc/musl mismatch on Linux. It lands in the app's own data directory, so
  nothing touches `PATH` or the registry and deleting the directory undoes it.
  Fetching it needed an HTTPS path that does not depend on Node, because the
  existing one runs `fetch` through `node -e` and cannot bootstrap Node itself;
  the crates it uses were already linked in by the updater plugin, so the binary
  did not grow. A second mirror serves the same bytes where nodejs.org is slow.
  The runtime it installs carries its own npm, so installing the harness still
  works the same way.
- **The release pipeline can sign, notarize, and publish a checksum manifest.**
  When credentials are configured, macOS builds use an Apple Developer ID,
  `notarytool`, and stapling, while Windows installers use Azure Artifact
  Signing. Without those credentials a fork still gets an unsigned build with a
  clear warning instead of a failed release. Every artifact's SHA-256 is
  collected into `SHA256SUMS.txt` for downloads served through a mirror.
- **A download page, and five package-manager channels.** The site is two
  bilingual static pages that link no webfont — a 2.7 MB installer should not
  ask you to fetch 200 KB of type from a CDN you may not reach — and it takes its
  design variables from the app's own stylesheet. Every link and size in the HTML
  is already correct before any script runs; the script only swaps in live values,
  because an unauthenticated GitHub API allows 60 requests per hour per address
  and a visitor behind a large NAT may arrive with none left. Manifests for Scoop,
  winget, Homebrew Cask, AUR and Flathub are generated from a real release rather
  than hand-edited, taking each digest from that release's own `SHA256SUMS.txt`.
  Only the Scoop bucket is live right now; [`packaging/README.md`](packaging/README.md)
  says what each of the other four is still waiting on.
- **First launch is a three-step setup instead of a wall of controls.** It picks
  a workspace, finds or installs Node and the harness, and chooses a profile
  preset before opening the main window. The same environment controls remain
  available afterwards, so onboarding is a starting point rather than a second
  configuration system.
- **A real terminal lives in the window.** Each tab runs through a platform PTY,
  supports resize, links, clipboard paste and terminal key handling, and is
  reclaimed with the window's process tree instead of leaving a shell behind.
- **Profiles are first-class.** Create, switch, inspect and manage multiple
  harness profiles, see how their plugins differ, and keep each profile's
  disabled-plugin choices independent across restarts.
- **Harness content gets a bounded desktop bridge.** A versioned client lets
  trusted content request the desktop actions a web frame cannot provide, while
  badges, notifications and deep links remain owned and validated by the shell.
- **Sessions have history, full-text search, artifacts and export.** Past runs
  can be found without opening files by hand, exported for sharing, and opened
  in parallel windows when one conversation is not enough.
- **Token and cost reports.** Usage is aggregated from recorded sessions, with
  configurable model rates and breakdowns that make both token volume and
  estimated spend visible.
- **Keyboard-first control.** A fuzzy command palette exposes navigation and
  common actions; configurable global shortcuts can summon the window, and
  launch-at-login can be managed from Settings.
- **Plugins can arrive as local packages.** Offline archives are inspected and
  installed through the same profile rules as registry packages, without
  quietly bypassing the harness's layer model.
- **One-click diagnostics export.** The About pane can produce a redacted report
  containing the environment and relevant logs, ready to attach to an issue
  without leaking credentials or requiring a manual scavenger hunt.

### Changed

- **Windows 11 uses Mica Alt where the compositor supports it.** The material
  follows light and dark appearance, with solid fallbacks on older Windows and
  other platforms.
- **Pointers, hover states and disabled controls behave like a desktop app's.**
  Anything clickable shows a hand, anything disabled does not pretend otherwise,
  and rows that respond to a click say so before it happens.
- **Every image in the README is now captured from the shipped UI.** The two
  hand-taken screenshots leaked a real home directory in the status bar, and one
  of them is now an animation instead: installing a plugin and pairing a phone
  are both sequences, and a still frame of either only shows the end. The script
  that produces them lives in [`media/`](media) and runs the actual interface
  against a stand-in backend, so nothing personal can appear in one by accident.

## [0.4.0] — 2026-08-17

This release adds a light palette and reversible plugin switches, fixes plugin
installation with NVM-managed Node on Windows, moves package details into a
focused dialog, and completes updates inside the app with signed verification.

### Added

- **A light palette, and a switch for it.** Three choices in the title bar —
  match system, light, dark — because the first two are not the same thing: a
  window that follows the desktop is right until you are the person who keeps
  the desktop dark and reads documentation in the light, and then it is wrong
  twice a day with no way to say so. "Match system" is the default and stays
  live, so a desktop that turns itself down at sunset takes the window with it.
  The choice is remembered, and applied before React draws anything: a window
  that renders dark and turns light a frame later is worse than one that was
  never asked to.

- **Installed plugins can be switched off without being uninstalled.** Removing
  a plugin to find out whether it is the reason something broke costs a download
  to put it back, which is enough friction that the question does not get asked.
  A switch on each row takes the package's patch out of the layer stack and
  leaves the package on disk, so the answer costs one click and the undo costs
  one more. The switch appears only where throwing it means something: a package
  that declares no patch has no layer to remove, and one that came with the
  profile template stays in the stack — both say so in words rather than
  offering a control that would quietly undo itself. The harness rebuilds the
  layer list from what is installed after every plugin command, so the shell
  re-asserts what you switched off after each one; nothing you turned off comes
  back on because something else was installed.

### Changed

- **Updates finish where they begin.** The prompt now opens localized release
  notes in DSH Studio, then downloads, verifies, installs, and restarts the
  signed update in place. Progress stays visible, and the release page remains
  available when a manual download is needed.
- **A package's details open in front of you instead of down the side.** The
  rail took 318px of window permanently, to hold something worth reading one
  package at a time, and it was empty until something was picked — while the
  Install button in it sat a long way from the row the eye was on. The details
  are now a dialog: the list gets the whole width back, and the decision arrives
  where the click happened. Escape, the dimmed area, and the close button all
  dismiss it, Tab stays inside, and the caret goes back to the row it came from.
  What it says is unchanged, because the reason the rail existed is unchanged —
  a registry search returns packages that merely mention the harness beside
  packages that extend it, and the only honest way to tell them apart is to read
  the published manifest.
- Removing a plugin from the installed list is an icon now rather than a word,
  and both lists open the same dialog and ask the same removal question, so
  which list you happened to be looking at no longer changes the wording.

### Fixed

- **Installing a plugin failed with `the plugin command exited with exit code: 1`.**
  The shell puts the detected Node's directory on the child's `PATH`, and it had
  been taking that path from `canonicalize`, which on Windows answers in
  extended-length form — `\\?\C:\Program Files\nodejs`. That prefix is a signal
  to the file system API to skip path parsing entirely, and `cmd.exe` cannot
  resolve an executable out of a `PATH` entry that carries it. So `npm` — a
  `.cmd` shim that shells out — could not find `node`, and every install died
  the moment the package manager was reached. The prefix is now stripped for
  ordinary drive paths before the variable is built, kept for volume GUID paths
  where it is the only form that works, and rewritten to `\\` for UNC paths so a
  Node on a network share still resolves. Covered by tests on Windows.

## [0.3.0] — 2026-08-17

The desktop shell feels more native, announces new releases without taking over
the update process, and replaces a shared remote secret with revocable device
credentials.

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

- **Tooltips the app draws.** `title` is the browser's: it waits a full second,
  arrives in Edge's shape rather than this window's, cannot hold a second line
  without looking like an accident, and lingers after a click has already moved
  the interface on. The replacement appears after a short rest and then
  instantly for as long as someone is reading labels, sits above what it
  explains, flips below it at the top of the window, and goes the moment
  anything happens. A control reached by Tab gets one too.

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

- **Remote access pairs with devices instead of handing out one key.** The QR
  code used to carry a secret that lasted as long as the session and worked for
  anyone who had ever seen it. It now carries a pairing code that the first
  device to use it spends, and that lapses two minutes after it appears — and
  what that device keeps afterwards is a credential of its own. The pane shows
  the code draining and puts up a new one on request. Below it, every phone that
  paired is listed with when it paired and when it was last heard from, and
  forgetting one revokes its credential and drops what it already had open: a
  revoke button that leaves a socket streaming has not revoked anything.
- **`SECURITY.md` says why the LAN gateway is not TLS.** Any certificate this
  project could ship would be self-signed, over an address that changes with the
  network and a port the kernel picks fresh each session — so it would put a
  full-page browser warning in front of every pairing, every time, because the
  exception a user grants never applies to the next origin. Teaching that click
  is worth more to an attacker than the encryption is worth to you, so the gap
  is closed from the other side, and the part that stays open is written down
  rather than left implied.
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

[Unreleased]: https://github.com/Moresyl/dsh-studio/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/Moresyl/dsh-studio/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Moresyl/dsh-studio/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Moresyl/dsh-studio/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Moresyl/dsh-studio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Moresyl/dsh-studio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Moresyl/dsh-studio/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Moresyl/dsh-studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Moresyl/dsh-studio/releases/tag/v0.1.0

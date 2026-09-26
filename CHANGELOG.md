# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the usual
pre-1.0 caveat that anything may still move.

[简体中文](CHANGELOG.zh-CN.md)

## [Unreleased]

## [0.9.15] — 2026-09-26

### Changed

- Rebuild the desktop hierarchy around a black navigation rail, an `#181818` workspace, `#212121` work surfaces, and inverse selected controls, with matching light-theme relationships instead of a flat single-surface layout.
- Tighten the desktop shell to a 264 px sidebar and 36 px title bar, center the mode selector, expose the current page in the title bar, and use 20 px content headings with bounded 780 px and 1040 px reading widths.
- Give the plugin marketplace a contained work surface and align Settings, About, Remote, Console, sidebar rows, tabs, theme controls, and page actions to the same compact geometry and typography.
- Replace all six English and Chinese README screenshots and animations with clean `1120×700` captures of the updated interface.

### Fixes and polish

- Update the deterministic plugin-install capture backend for the current one-shot preview-token contract, show the security review before confirmation, and end on the correct Installed tab after the marketplace gained an Installable tab.
- Keep README capture overlays outside the recorded application area and validate every animation frame before APNG encoding.

### Verification

- Local release validation passed: production build, lint, 281 frontend tests at 95.1% statement coverage, 59 packaging tests, 408 Rust tests, accessibility checks, public-contract checks, and bilingual documentation checks.
- Browser checks covered dark and light themes, the open selector, compact and 744 px layouts, loaded OpenAI Sans faces, zero horizontal overflow, and a clean error console after a full reload.
- The documentation assets were verified at `1120×700`: 34 frames per plugin animation, 12 frames per remote-pairing animation, and one frame per console image.

## [0.9.14] — 2026-09-25

### Added

- Bundle OpenAI Sans Regular, Medium, and Semibold with the application so the desktop interface uses the intended 400, 510, and 590 weights consistently instead of depending on a system-installed font.

### Changed

- Match the updated desktop reference with a 36 px title bar, 20 px default buttons, 22–28 px field and selector sizes, a 450 px confirmation dialog, a 520 px command palette, and the corresponding 6–16 px corner radii.
- Use the reference tooltip treatment and compact typography: 14 px dark tooltips, 12 px controls, restrained neutral fills, and a blue focus edge only where focus needs to remain explicit.
- Rework preset choices as neutral 16 px radios with a 6 px inverse center, stable selected-row geometry, roving focus, and wrapping arrow, Home, and End key navigation.

### Fixes and polish

- Treat malformed worktree replies as an empty collection so the Settings pane degrades cleanly instead of crashing while a backend or browser fixture is incomplete.
- Extend the browser fixture with startup, worktree, and preset commands so the same Settings and preset surfaces can be inspected without native IPC.

### Verification

- Local release validation passed: production build, lint, 277 frontend tests at 95.1% statement coverage, 59 packaging tests, 408 Rust tests, accessibility checks, public-contract checks, and bilingual documentation checks.
- Browser checks covered dark and light themes, the open selector, preset pointer and keyboard selection, command-palette geometry, tooltip geometry, font loading, and a clean console after a full reload.

## [0.9.13] — 2026-09-25

### Changed

- Replace the remaining native dropdown popups with the shared menu-backed selector so trigger, open, highlighted, selected, disabled, pointer, and keyboard states use one measured desktop interaction model.
- Match the reference control geometry with 8×5 px chevrons, 12 px dropdown corners, 6 px menu gutters, 8×12 px item padding, 14 px item text, 18 px selection indicators, and 590 selected-item weight.
- Give command-palette rows the reference 75% resting opacity and quiet translucent highlight instead of the heavier secondary surface.

### Fixes and polish

- Keep outline inputs transparent and use the neutral 50% inset focus edge from the reference tokens; selectors retain the distinct inward 2 px blue focus ring.
- Mark single-choice menu entries with checked radio-menu semantics, restore focus when the menu closes, and expose the active descendant while navigating with the keyboard.
- Remove owned, content-hashed web assets before Windows NSIS upgrades so old bundles cannot survive an in-place install or block complete uninstall. Full installers also refresh their owned offline payload, while Lite updates preserve it.
- Supersede the incomplete `v0.9.12` release run, whose Windows Full upgrade check correctly caught stale assets left by the previous installer.

### Verification

- Local frontend build, lint, 275 frontend tests at 95.1% statement coverage, 59 packaging script tests, Rust workspace tests, accessibility checks, and public-contract checks passed.
- Lite and Full Windows NSIS installers compiled locally with their separate upgrade hooks. Browser checks verified selected dropdowns and input geometry in dark and light themes.
- The release pipeline validates Lite and Full packages on Linux, Windows, and macOS, including an in-place Windows upgrade and clean uninstall, before publishing checksums and the signed updater manifest.

## [0.9.12] — 2026-09-24

### Fixes and polish

- Run Windows NSIS uninstall smoke tests synchronously with the documented `_?=<install directory>` argument, then remove only the uninstaller and empty directory tree. Genuine packaged-file residue now fails with the remaining paths instead of timing out on an asynchronous launcher.
- Supersede the incomplete `v0.9.11` release run while preserving its unified input, select, switch, focus, and compact-dialog treatment.

### Verification

- Local frontend build, lint, 274 frontend tests at 95.1% statement coverage, 57 packaging script tests, Rust workspace tests, accessibility checks, and public-contract checks passed.
- Browser checks covered both themes, 1102px and 884px desktop layouts, and the 744px full-window dialog layout without horizontal overflow or clipped control text.
- The release pipeline validates Lite and Full packages on Linux, Windows, and macOS, then publishes checksums and the signed updater manifest only after all package smoke tests pass.

## [0.9.11] — 2026-09-24

### Changed

- Align native selects, text and number fields, menu-backed pickers, focus rings, and switches with the measured desktop chat control tokens while preserving native keyboard semantics and required accessible labels.

### Fixes and polish

- Make all six modal surfaces fill compact windows below 48rem without borders or rounded corners, while retaining their task-specific desktop widths.
- Allow the asynchronous Windows NSIS uninstaller up to 60 seconds to remove an upgraded test installation, avoiding false release failures on slower hosted runners.
- Supersede the incomplete `v0.9.10` release run with a clean patch release while preserving the desktop UI, selected-runtime compatibility, and application behavior introduced there.

### Verification

- Local frontend build, lint, 274 frontend tests at 95.1% statement coverage, 55 packaging script tests, Rust workspace tests, accessibility checks, and public-contract checks passed.
- Browser checks covered both themes, 1102px and 884px desktop layouts, and the 744px full-window dialog layout without horizontal overflow or clipped control text.
- The release pipeline validates Lite and Full packages on Linux, Windows, and macOS, then publishes checksums and the signed updater manifest only after all package smoke tests pass.

## [0.9.10] — 2026-09-24

### Added

- Give the Studio workbench a persistent, collapsible sidebar for its tools, recent sessions, settings, and profile selection. Recent sessions open directly.

### Changed

- Match the desktop chat design tokens with a neutral light/dark ramp and an OpenAI Sans-first system UI font stack using the original 510/590 interface weights. Use a 46 px title bar, center the view selector, give the expanded sidebar a 275 px width, and use 40 px primary navigation rows. The managed Harness integration synchronizes semantic theme colors with the Studio window.
- Keep Harness's own conversation sidebar in chat mode instead of stacking two navigation columns. Put runtime state above a full-width console log and switch to one column when the content area is narrow.

### Fixes and polish

- Make the workbench search action open the session list and focus its search field, including when leaving a reader or another session tab.
- Update capture fixtures for the current session, profile, and plugin catalog contracts and wait for lazy panes before taking preview frames.
- Pin the Cordis core and plugin compatibility floors declared by each selected Harness release, preventing npm dependency drift from terminating older runtimes after readiness. Probe the real document and preserve Harness output when startup fails.

### Verification

- Local frontend build, lint, 269 frontend tests, 53 packaging script tests, Rust workspace tests, and public-contract checks passed.
- Browser checks covered both themes, the 900×620 minimum window, expanded and collapsed navigation, title-bar overlap, recent-session opening, search focus, and Harness theme-token overrides. Isolated cold installs and real Profile boots passed for both `0.1.1-rc.1` and `0.1.2-rc.1`; the release pipeline validates native packages.

## [0.9.9] — 2026-09-22

### Changed

- Serve the Studio shell from the loopback origin so Harness `0.1.2-rc.1` can authenticate in the embedded window without weakening its cookie policy.
- Align the main chrome, pane headings, buttons, and status text to consistent UI type roles; give actionable controls restrained press feedback and touch-friendly behavior.

### Fixes and security

- Preserve same-site navigation and bound the loopback cookie header; support both generations of the Studio integration client.
- Keep Rust-only checks working from a clean checkout without a generated frontend bundle, and cover that path in CI.
- Replace the obsolete incompatible-authentication CI assertion with a real isolated install and Profile boot of Harness `0.1.2-rc.1`.

### Verification

- Windows isolated installation and real Profile boot of Harness `0.1.2-rc.1` passed; frontend build, lint, 269 frontend tests, 51 packaging tests, and the Rust workspace tests passed locally.
- CI tests the selected Harness on Linux, Windows, and macOS. No physical macOS device was available for validation.

## [0.9.8] — 2026-09-15

### Added

- Query official npm Harness releases and install an exact selection, including upgrades and downgrades, gated by an isolated install and real Profile startup.

### Fixes and security

- Upgrade Rustls to `0.23.45` to fix TLS handshake encryption-level boundary validation (`RUSTSEC-2026-0285`).
- Pin Harness family members and required peers to the selected version to prevent mixed-release exports and missing services.
- Preserve verified runtime selection and legacy markers; failed candidates retain the current runtime, and Repair targets the last verified selection.
- Serialize runtime replacement against plugin mutations and surface retryable catalog errors through the shared error dialog.
- Verify browser authentication and reject strict-cookie releases incompatible with the embedded window. `0.1.2-rc.1` and `0.1.5-rc.2` currently cannot activate; upstream authentication remains enabled.
- Support exported CLI entry points on older Node versions without `import.meta.main`; preserve navigation tokens while redacting logs and tray labels.

### Verification

- Tested Windows cold installation of `0.1.1-rc.2`, real Profile boot after selecting `0.1.1-rc.1`, and the embedded strict-cookie failure in a browser.
- Added selected-version startup and incompatible-version rejection to the three-platform CI matrix. No physical macOS device was available.

### Documentation

- Reworked the English and Chinese documentation landing pages into task-oriented paths, with a five-minute first-run guide, recovery guidance, and a more useful issue-reporting checklist.

## [0.9.7] — 2026-09-13

### Fixed

- Fixed the cross-platform runtime-contract CI job so pnpm is installed before cold profile boot.

### Changed

- Upgraded checkout and Node setup actions to their Node.js 24-compatible releases.
- Added branch-run concurrency cancellation to prevent stale CI jobs from racing newer commits.

### Verification

- Verified the release gate across Windows, macOS and Linux, including cold runtime installation, Rust tests, accessibility, contracts, packaging and coverage.

## [0.9.6] — 2026-09-13

### Fixed

- Fixed malformed closing markup in the bilingual download-page release labels.

### Changed

- Serialized release and channel metadata writers to reduce concurrent publication races.

## [0.9.5] — 2026-09-12

### Fixed

- Preserved actionable updater errors when native cleanup also fails.
- Bounded GitHub release metadata requests and explained timeouts on the download page.

### Added

- Added bilingual documentation search, shortcut guidance, and an empty state.
- Added a platform support and verification matrix.

### Changed

- Improved documentation keyboard navigation and landmark semantics.

### Changed

- Improved documentation keyboard navigation with skip links and labelled landmarks.
- Bounded the website's GitHub release metadata request and made its session cache optional.

### Fixed

- Preserved the original updater download or relaunch error when native resource cleanup also fails.

## [0.9.4] — 2026-09-12

### Added

- Added a bilingual documentation hub with user, troubleshooting, release and roadmap entry points.
- Added automated checks for website navigation and bilingual documentation pairs.

### Changed

- Improved static-site navigation, 404 handling, sitemap, robots and canonical metadata.

### Fixed

- Cleared stale release results after a failed manual update check so the UI cannot present an old version as current.
- Aligned application, Tauri and Rust package version metadata to the published release.

## [0.9.2] — 2026-08-29

### Fixed

- Replaced retry-only recovery for intermittent Windows profile junction failures
  with a Studio-owned Node resolver. Normal Profile resolution remains first; only
  missing official `@deepseek-ai/*` imports fall back to the qualified managed
  Harness. Existing 0.9.1 runtimes gain the resolver atomically at launch without
  deleting or rewriting the selected Profile or its plugins.
- Added launch-contract, resolver isolation and real-Profile fault-injection tests.
  The Windows acceptance test continuously removed the four links from the reported
  failure while the real user Profile completed ten consecutive boots and HTTP
  health checks.

## [0.9.1] — 2026-08-28

### Changed

- Windows package smoke tests now isolate Studio, Harness and Profile state. Local
  release rehearsals verify the MSI-extracted executable without registering a
  temporary NSIS install; stateful NSIS and in-place upgrade checks remain enabled
  on ephemeral GitHub Actions runners.
- The release workflow now persists the freshly generated signed updater manifest
  on protected `main`, then explicitly dispatches and waits for the Website workflow
  to deploy GitHub Pages after all artifacts and checksums are complete. The secondary
  endpoint cannot remain pinned to an older release when a `GITHUB_TOKEN` release
  does not emit another workflow event.

### Fixed

- Fixed Harness startup occasionally failing after an install or upgrade because
  the Profile-level fallback briefly resolved official `@deepseek-ai/*` modules
  while the managed runtime junction was being promoted. Studio now gives only this
  installation-owned race a longer bounded recovery window and reports a short,
  actionable error if the modules remain unavailable; user plugins are preserved.
- Fixed a manual **Check for updates** click being silently discarded while the
  quiet launch-time check was still running. Manual checks now join the active
  request and display its success or failure.
- Fixed the Worktree Manager surfacing Git's fatal “not a git repository” message
  for an ordinary non-Git workspace. It now shows an empty state and keeps creation
  controls disabled until a Git repository is selected.
- Fixed local package verification leaving a temporary installer path registered as
  the primary Windows application, which could make shortcuts and later upgrades
  launch a deleted smoke-test copy.

## [0.9.0] — 2026-08-28

### Added

- Added an isolated Studio-owned Safe Mode Profile that rebuilds only the official
  base/web layers, never adopts an unmarked user Profile and leaves the selected
  Profile unchanged.
- Added portable `.dshpreset` import/export with a versioned manifest, per-file
  SHA-256 verification, strict path and size limits, preview, collision refusal
  and atomic activation. Only user-authored preset files are exported.
- Added plugin trust and resource evidence covering runtime compatibility,
  registry integrity, repository identity, lifecycle scripts, deprecation,
  direct dependency count, unpacked size and native-build declarations.
- Added native Git worktree discovery and collision-safe branch worktree creation,
  plus a Worktree Manager that can reveal or switch to each isolated workspace.
- Added reversible session archiving. Studio persists only the archive index and
  never edits or deletes the Harness-owned append-only session logs.

### Changed

- LAN remote access now suspends during a transient Harness restart and resumes
  on the same address and port with the same in-memory per-device credentials.
  Explicit Close still revokes every credential and prevents automatic reopen.

### Fixed

- Fixed concurrent atomic replacements on Windows intermittently failing with an
  access/sharing violation while another writer, Defender or an indexer was
  releasing the destination. Only those two transient Windows errors receive a
  short bounded retry; all other permission errors still fail immediately.

- Fixed upgrades from 0.7.8/0.8.0 opening an empty desktop surface when the saved
  presentation expected an upstream page but Harness was stopped. Compatibility,
  Extended and Advanced preferences remain intact, while the local Workbench is
  now always available whenever no upstream surface exists.
- Split-chunk failures now rearm generation-safe native startup recovery, reload
  at most once per window and fall back to a visible renderer error surface rather
  than a blank or looping window. The native ready handshake waits for the critical
  lazy startup surface, and the static document remains legible before JavaScript.

## [0.8.0] — 2026-08-25

### Added

- Added a native startup watchdog and static recovery window that do not depend on React, Harness, Node
  or the network. If the renderer never completes its first handshake, users can still inspect redacted
  diagnostics, retry startup or exit instead of being left with an inert blank window.
- Added Extended presentation mode, combining the complete upstream page with a compact desktop toolbar.
  The Harness may keep a random port or use a persisted local port from 1024–65535 with preflight conflict checks.
- Added read-only Host Protocol 1 to the SDK and runtime integration. Harness plugins can inspect bounded
  version and Profile facts without command, native-handle, package-mutation or Profile-mutation privileges.
- Added native catalog protocol/latency/installability health checks, SHA-256 verified Profile restore previews,
  local monthly budget status and spreadsheet-safe daily CSV usage export.

### Changed

- The GitHub Actions release matrix cold-installs the complete runtime graph on Windows, Linux and macOS and
  boots a real Profile, Loader, web port and Host probe before proceeding.
- Persistent exports, settings, Profiles and plugin recovery state now use same-directory staging, write-through
  and atomic replacement. Cancellation reliably releases Profile and plugin operation locks.
- Update approval is bound to the exact reviewed release. Accessibility, bilingual-document and production
  bundle-budget checks are release gates; the terminal emulator is loaded on demand and the entry bundle is capped at 450 KiB.

### Fixed

- Fixed renderer startup failures leaving only a blank window with no desktop recovery or diagnostic export path.
- Fixed cancelled Profile or plugin operations retaining task locks and making later actions appear permanently busy.
- Fixed an update check changing during confirmation and allowing a different release to inherit stale approval.
- Fixed failed replacement writes potentially damaging an existing valid setting, export or recovery file.
- Explicit user-action failures now open localized, selectable and copyable dialogs while background refresh errors remain non-modal.

### Performance and polish

- Workbench, Profile Manager and xterm are lazy-loaded to reduce initial parsing when those features are unused.
- Expanded bilingual documentation, public-contract, accessibility, bundle-budget, refusal-path and desktop-bridge lifecycle coverage.

## [0.7.8] — 2026-08-24

### Added

- Plugin installation now resolves the complete dependency graph before review and again before
  touching the Profile, using Studio's managed Node, exact pnpm and the same registry in a disposable
  project. The check writes only a lockfile, runs no lifecycle scripts and never mutates the real Profile.
- Plugin search, detail, source and mutation failures retain their inline history and also open a
  localized, copyable diagnostic dialog with the relevant `ERR_PNPM_*`, network, disk or permission cause.

### Changed

- Destructive Harness, terminal, plugin, preset and remote-session actions are mutually exclusive.
  Asynchronous refresh, detail and search results write back only while they still belong to the current
  selection, preventing rapid clicks or cross-window announcements from restoring stale state.
- Windows log-level settings use replace-existing, write-through atomic updates. Shortcut and notification
  settings serialize their writes and restore the previous registered shortcut when persistence fails.

### Fixed

- Fixed [#12](https://github.com/Moresyl/dsh-studio/issues/12): the reviewed
  1024Store snapshot may exceed the custom-source 2 MiB ceiling, dshfind now
  uses its bounded server-side desktop search instead of trying to scan more
  than 10,000 entries, and exact prerelease npm versions such as `1.2.3-rc.1`
  pass the same integrity, compatibility, lifecycle and repository checks as
  exact stable versions. Ranges, tags and build metadata remain blocked.
- Fixed [#11](https://github.com/Moresyl/dsh-studio/issues/11): the xterm Unicode 11 addon was activated
  before proposed APIs were enabled, so New terminal could throw before creating a PTY and appear inert
  on Windows 11.
- An install preview left open until its one-shot token expires is reviewed once again automatically.
  If its package, version or source changed, Studio returns to detail instead of installing from stale intent.
- When a plugin's complete dependency graph contains a registry package that is missing or inaccessible,
  installation stops before the real Profile changes and reports the package-manager cause such as
  `ERR_PNPM_FETCH_404`, not only `pnpm failed in profile directory`.
- Fixed overlapping start/stop/install, terminal create/close, plugin/source, preset and remote-session
  actions, plus late Profile, session, startup-settings and plugin refreshes overwriting successful state.

## [0.7.7] — 2026-08-23

### Added

- Node runtimes shown in Environment can now be selected explicitly. The choice
  is persisted and falls back safely when that installation disappears.
- Settings can request native notification access and send a test notification,
  making macOS Notification Center registration observable instead of implicit.

### Changed

- macOS autostart now uses a real Login Item so it appears in System Settings and
  startup-management tools while still launching Studio hidden in the tray.
- The embedded terminal uses Unicode 11 cell widths and a full-height screen so
  box drawing, CJK, emoji and full-screen TUIs keep their layout.
- Dark macOS Vibrancy content uses opaque dark grounds instead of sampling a
  light or inactive desktop through the window.

### Fixed

- Fixed catalog discovery being rejected when DNS returned a public address next
  to a private or special-use address. Requests remain pinned to one admissible
  public address, and hosts with no admissible address are still blocked.
- Expanded special-use and IPv4-mapped IPv6 checks in the catalog SSRF guard.
- Fixed the selected Node runtime not being honoured by Harness launch and npm
  installation planning.

## [0.7.6] — 2026-08-23

### Added

- The macOS application menu now exposes Check for Updates and Restart DSH
  Studio while retaining the platform's standard edit, window, hide and quit
  commands instead of the unhelpful default File / View / Help menus.
- The embedded terminal adds explicit copy, paste and clear actions, native
  platform shortcuts and an always-available scroll lane.

### Changed

- The managed Harness moves from `@deepseek-ai/dsh@0.1.0-rc.8` to
  `0.1.1-rc.2`. Online and offline setup still consume the same fully locked
  dependency graph, with pnpm remaining pinned to 11.7.0.
- Packaged Unix terminals recover PATH from a bounded, credential-filtered login
  shell environment and prefer those recovered developer tools over an
  incomplete GUI-process PATH.
- Installed local `link:`, file and Git plugins now display verified profile
  metadata directly instead of being reinterpreted as npm registry packages.

### Fixed

- Fixed [#4](https://github.com/Moresyl/dsh-studio/issues/4): when the Harness is
  already available on macOS, Studio no longer reports a missing package manager
  merely because pnpm is not installed globally. It reuses an exact pnpm match
  from Studio tools or the managed Harness.
- Fixed installed local/Git plugin details issuing an npm registry request and
  ending in HTTP 404.
- Fixed macOS GUI launches losing login-shell tools such as `claude` and
  `starship`, which could also trigger a Powerlevel10k warning.
- Fixed terminal selection, copy, paste and scrolling. Selection copy does not
  steal ordinary `Ctrl+C` interrupt semantics from Windows/Linux shells.
- npm cache, resolution progress and ordinary informational stderr are no longer
  all rendered as errors; warnings and genuine errors remain distinct.
- Startup failure details are width-bounded, wrapped and internally scrollable
  so they cannot push the workspace out of its layout.

## [0.7.5] — 2026-08-22

### Added

- The plugin Sources view now links to DSH Hub as a community discovery
  directory and explains the safe workflow: copy a listed npm package name back
  into Studio, where the existing exact-version install review still applies.

### Changed

- Harness installation now chooses the newest compatible Node runtime that has
  a working npm, rather than allowing a newer Node-only installation to hide a
  complete runtime already on the machine.
- npm entry points are executed with the exact selected Node before use. Plugin
  operations preserve the pnpm store already recorded by an existing profile;
  new profiles receive a stable Studio-owned store instead of inheriting a
  changing GUI shell configuration.
- DSH Hub remains an external website directory, not an installation authority.
  Studio does not scrape its HTML or accept it as a custom Schema 1.0.0 endpoint.

### Fixed

- Fixed [#3](https://github.com/Moresyl/dsh-studio/issues/3): Homebrew Node
  installations remain usable after their `node` symlink is canonicalized into
  the Cellar. Both formula-owned `libexec` npm and prefix-shared npm layouts are
  recognized on Apple Silicon and Intel Macs.
- A supported Node installation without npm no longer blocks online Harness
  setup. Studio automatically downloads and verifies its managed complete Node
  runtime, then resumes the original Harness installation.
- Fixed intermittent startup failures where concurrent Environment, tray and
  window actions could observe a managed Harness promotion while profile module
  fallbacks were being refreshed. Runtime inspection, installation and startup
  now share one lifecycle gate, wait for supervised shutdown, and narrowly retry
  only transient managed-package resolution failures.
- Fixed manually dispatched releases uploading the Windows portable build to a
  nonexistent `main` tag instead of the configured version tag.

## [0.7.4] — 2026-08-22

### Fixed

- Fixed a transient black console window appearing when Start ran the Harness
  composition preflight or launched the supervised Node process on Windows.
  Both paths now use `CREATE_NO_WINDOW` while keeping stdout and stderr in the
  Studio activity log.
- Managed Harness and pnpm installation now use the same hidden-console launch
  contract, so first install and Repair do not flash `node.exe`, `npm` or their
  lifecycle console host over the desktop window.

## [0.7.3] — 2026-08-22

### Added

- Startup now preflights the exact composed loader tree with the Harness's own
  `--dump-config` path before any plugin is booted. Duplicate entry ids include
  their owning layers in the diagnostic.

### Changed

- The Studio integration is now a launcher-owned runtime patch, resolved from
  the shared profile module fallback, instead of a bundle persisted in user
  profiles. Existing profile entries are migrated without reordering user
  plugins, and headless profiles receive no Web integration layer.

### Fixed

- Fixed startup aborting with `duplicate loader entry id: code-runtime` and the
  secondary `harness closed its output without announcing a port`. When an
  active installed third-party bundle conflicts with rc.8 core ids, Studio
  disables only that bundle, records the reversible switch, recomposes, and
  starts normally. Core, Studio and user-patch conflicts still fail closed.
- Runtime qualification is idempotent when Repair examines an already-qualified
  directory picker, instead of treating its retained source seam as a second
  patch opportunity.
- Fixed Studio startup opening an external browser through the Web CLI default.
  Initial launch and supervised restarts now explicitly suppress browser
  handoff and keep the surface inside the Studio window.

## [0.7.2] — 2026-08-22

### Added

- A validated GitHub Pages fallback for the signed updater manifest. Package
  channel generation now copies `latest.json` only after its version, HTTPS
  artifact URLs and every Tauri signature pass validation.
- Runtime contract failures now identify the exact missing condition instead of
  reporting only the Harness and pnpm versions that happened to be present.

### Changed

- Managed installation materializes the bundled Studio integration as an
  ordinary directory with npm `--install-links`; Windows no longer depends on a
  temporary directory junction surviving verification, promotion or cleanup.
- Update checks try the GitHub Release feed and then the official Pages feed.
  Feed and package-manifest downloads retry bounded transient failures, while
  downloaded application artifacts still require the embedded Tauri public key.

### Fixed

- Fixed a post-install Contract 2 failure where npm successfully installed all
  511 packages but Studio rejected the runtime because its local integration
  was represented by a Windows junction. First install, update and Repair now
  use the same materialized integration contract.
- One-click update no longer exposes only `error sending request for url` when
  the primary GitHub manifest is unreachable. It falls back to Pages and, if
  every route fails, explains GitHub/`HTTPS_PROXY` recovery and the Full /
  Offline option in Chinese and English.

## [0.7.1] — 2026-08-22

### Added

- A headless `--export-diagnostics` command that creates a bounded diagnostic
  ZIP from existing logs and crash evidence before Tauri, a window or Harness
  starts, then prints the archive's absolute path.

### Changed

- Headless export uses the existing redaction, evidence-count and 50 MiB archive
  limits. It writes a unique timestamped file to Downloads, with a safe
  application-data fallback when Downloads is unavailable.
- Managed Harness installation now uses the official registry recorded by the
  qualified lock instead of allowing npm to rewrite locked tarballs through an
  incomplete user mirror. Native lifecycle stages are visible in the log, with
  bounded fetch retries and explicit idle/total safety limits.

### Fixed

- Startup failures no longer prevent users from collecting the evidence needed
  to diagnose them. Headless flags with extra arguments fail immediately with a
  non-zero exit code instead of accidentally launching the desktop application.
- Fixed [#2](https://github.com/Moresyl/dsh-studio/issues/2): Harness installation
  can no longer stay on “Installing” forever after package resolution. A silent
  npm process is terminated with an actionable error, and inherited Windows
  output handles cannot keep the UI waiting after npm has exited.

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
  absolute AppImage path while unpacking RPMs directly with libarchive. Windows
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

[Unreleased]: https://github.com/Moresyl/dsh-studio/compare/v0.9.7...HEAD
[0.9.4]: https://github.com/Moresyl/dsh-studio/compare/v0.9.2...v0.9.4
[0.9.2]: https://github.com/Moresyl/dsh-studio/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/Moresyl/dsh-studio/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Moresyl/dsh-studio/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Moresyl/dsh-studio/compare/v0.7.8...v0.8.0
[0.7.8]: https://github.com/Moresyl/dsh-studio/compare/v0.7.7...v0.7.8
[0.7.7]: https://github.com/Moresyl/dsh-studio/compare/v0.7.6...v0.7.7
[0.7.6]: https://github.com/Moresyl/dsh-studio/compare/v0.7.5...v0.7.6
[0.7.5]: https://github.com/Moresyl/dsh-studio/compare/v0.7.4...v0.7.5
[0.7.4]: https://github.com/Moresyl/dsh-studio/compare/v0.7.3...v0.7.4
[0.7.3]: https://github.com/Moresyl/dsh-studio/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/Moresyl/dsh-studio/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/Moresyl/dsh-studio/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Moresyl/dsh-studio/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Moresyl/dsh-studio/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Moresyl/dsh-studio/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Moresyl/dsh-studio/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Moresyl/dsh-studio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Moresyl/dsh-studio/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Moresyl/dsh-studio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Moresyl/dsh-studio/releases/tag/v0.1.0

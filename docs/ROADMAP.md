# DSH Studio roadmap and current benchmark

[简体中文](ROADMAP.zh-CN.md)

Updated 2026-08-25. The refreshed benchmark head is
`anywhere-labs/dsh-desktop` at
`87047b54ccd6c1d34fc3890755f836883889ec01`, with its Harness submodule at
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`). Its current
package identifies itself as 2.0.3 even though the preceding verified snapshot
`bd5ba85a275258318134632b3cc13d6b5ea8088b` identified itself as Benchmark
2.0.4, so this comparison uses commit identity rather than treating the
non-monotonic package field as a release ordering. The DSH Studio comparison
started at `9d608e7245e74662a67fe754222fd1b845270092`.

This document avoids volatile star/download counts and never treats pipeline
support as proof that an external channel or platform signature is live.

## Summary

DSH Studio is no longer catching up to a window wrapper. It covers
Windows/macOS/Linux; Lite and verified Full/Offline packages; a plugin market;
authenticated mobile remote access; Profiles; PTY terminal; multiple windows;
session search, usage/cost and export; command palette; diagnostics; and bounded
plugin contracts.

The remaining gaps are concentrated in:

1. **Distribution trust and reach:** OS-signing credentials, initial external
   package-manager submissions, a stable mirror, and community reach.
2. **Physical-device acceptance:** cross-platform CI is not evidence for a real
   signed macOS install, update, notification, login item, or terminal flow.
3. **Packaged UI automation:** logic coverage and a real Harness boot gate exist,
   but final installers still need repeatable WebView/window interaction smoke.

## Current capability matrix

| Capability              | Benchmark head `87047b54`                 | DSH Studio now                                                                                                                         |
| ----------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| No system Node required | Bundled Electron/runtime                  | Lite downloads and verifies official Node; Full carries SHA-256-pinned Node, Harness and pnpm                                          |
| Real runtime gate       | Profile boot smoke                        | Cold-installs the full 511-package graph and boots the real Profile, Loader, Web server and Host probe on Windows/Linux/macOS CI       |
| Presentation            | Compatibility / Extended / Advanced       | All three; Extended preserves upstream UI with a compact native toolbar                                                                |
| Stable Web origin       | Fixed port support                        | Random by default or persisted 1024–65535; occupied fixed ports fail before Node starts                                                |
| Startup recovery        | Injected recovery resources               | 12-second native watchdog and a static recovery window independent of React, Harness, Node and network                                 |
| Profiles                | Management, switching, desktop service    | Create/copy/rename/delete/import/export/diff and cross-window switching                                                                |
| Host plugin service     | Mutable Profile and managed pnpm services | Read-only Host Protocol 1; mutations stay behind visible Protocol 3 review, receipts and rollback                                      |
| Plugin market           | Built-in Community Market                 | Multi-source catalogs, pagination/limits, exact npm revalidation, preview token, integrity receipt, transaction rollback and UI errors |
| Catalog health          | Source management and tests               | Native contract/latency/installability health checks for npm, dshfind, 1024Store and custom sources                                    |
| Terminal                | Built in                                  | PTY, Unicode 11 and process-tree ownership; no external CMD flash                                                                      |
| Mobile remote           | Planned                                   | Delivered: loopback Harness plus separate LAN gateway, one-use QR and revocable per-device credentials                                 |
| Sessions                | Primarily upstream UI                     | Local full-text search, project filter, per-model token/cost reports and Markdown/HTML/JSON export                                     |
| Usage controls          | Upstream session UI                       | Local monthly budget status, complete-price guard and spreadsheet-safe daily CSV trend export                                          |
| Multiple windows        | Desktop window management                 | Parallel windows on one Harness with placement persistence                                                                             |
| Platforms               | Windows x64 and macOS Universal           | Windows x64, Linux x64, macOS Intel/Apple Silicon, plus Universal Lite image                                                           |
| Process lifetime        | Electron runtime ownership                | Windows Job Object / Unix process group owns the full Node, PTY and tool tree                                                          |
| Diagnostics             | Logs/recovery                             | Redacted bounded ZIP, rotated logs, crash evidence, Windows minidump and headless export command                                       |
| Durable writes          | File-backed recovery contracts            | Same-directory unique staging, full flush and atomic Windows/Unix replacement for exports and persistent state                         |
| Accessibility           | Native-frame refinements                  | Keyboard/dialog/form semantics gate, reduced motion, forced colours and bilingual manual acceptance matrix                             |
| Startup payload         | Bundled Electron surface                  | Terminal emulator is lazy; entry JavaScript is gated below 450 KiB and currently 364,959 bytes                                         |
| Update                  | Desktop updater                           | Mandatory Tauri signature, GitHub + verified Pages manifest fallback, asset matrix and SHA256SUMS gates                                |
| Package managers        | Website installers                        | Scoop live; winget/Homebrew/AUR/Flathub manifests generated and natively validated, but not all externally submitted                   |

## Delivered in this benchmark pass

- `2c0761f`: cold full-graph install and real Profile/Loader/Web gate on three OSes.
- `895b167`: renderer handshake, watchdog, static recovery and redacted export.
- `9fe39ab`: optional fixed loopback port, persistence, conflict preflight and UI error.
- `026f3df`: Extended presentation and lazy-loaded heavy workspace surfaces.
- `2de525a`: Host Protocol 1, SDK types, bounded roster, disposal and real Loader probe.
- `ad588d9`: cancellation-safe Profile/plugin job ownership.
- `fd193d3`: SHA-256 verified Profile backup and restore preview.
- `472e520`: native catalog contract health checks.
- `ae86fc5`: update confirmation bound to the exact reviewed release.
- `f293373`: local budget status and spreadsheet-safe trend export.
- `31a665a`: global copyable errors for explicit actions, with quiet background refresh.
- `6ad66d5` and `4e62d62`: accessibility gates, forced colours and labelled controls.
- `39bc348`: atomic export, settings, Profile and plugin-recovery writes.
- `ff21525`: terminal-emulator code split and a release bundle-size budget.

These commits are included in the v0.8.0 release candidate. Final availability
still depends on verifying the tagged pipeline, public assets, updater signatures and checksums.

## Next phase

### P0 — trust and physical-device proof

- Run the existing Azure Artifact Signing and Apple Developer ID/notarization/
  stapling paths with real credentials. Claim OS signatures only after artifact
  verification proves them.
- On real Intel and Apple Silicon Macs, cover first install, Gatekeeper, login
  item, notifications, picker, terminal, Full/Offline and in-app update. No Apple
  device is currently available, so CI remains build/headless evidence only.
- Exercise Lite→Lite and Full→Lite upgrades from the previous two formal
  releases, including damaged manifests, offline state and Profile/plugin/
  credential retention.

### P0 — distribution

- Submit and maintain winget, an independent Homebrew tap and AUR. Advertise
  Flathub equivalence only after the host developer-tool boundary is solved.
- Establish a byte-identical mainland mirror with independent checksum/signature
  retrieval, lag/error monitoring and a named operator. Do not endorse temporary
  GitHub proxies.
- Make the website's channel/version/architecture/Lite-vs-Full status derive
  from verified release assets instead of hand-edited claims.

### P1 — final-package automation

- Windows installer: install → onboarding → runtime → start → terminal → three
  presentations → restart → uninstall.
- Linux AppImage/deb/rpm: WebKit launch, PTY, picker, tray and process-tree cleanup.
- Add the same macOS flow after physical hardware and credentials exist; until
  then retain the explicit “built/tested in CI, not physically validated” label.
- Upload screenshots, WebView console, Harness tail and diagnostics on failure,
  not only an exit code.

### P1 — plugin ecosystem

- Publish the SDK and Host Protocol 1 documentation with the next formal release,
  plus a third-party fixture and compatibility-test template.
- Publish machine-readable catalog-health receipts for providers. Local native
  contract/latency/installability checks are delivered; an HTML website remains
  discovery, never an install authority.
- Add narrow Host capabilities only for demonstrated use cases. Generic package
  mutation, arbitrary commands and native handles stay outside the read-only
  service and behind the visible Protocol 3 transaction boundary.

### P2 — product depth

- Date trends, local budget status and spreadsheet-safe CSV export are delivered.
- Verified Profile snapshot/restore previews without credentials are delivered.
- Structural keyboard/form/dialog gates, reduced motion, forced colours and the
  screen-reader/200% zoom/manual acceptance matrix are delivered. Physical
  assistive-technology runs remain a release-candidate task.
- Consider opt-in, removable anonymous reliability metrics only after privacy and
  retention rules exist; do not add a telemetry SDK first.

## Release decision

A future release requires an audited worktree/version diff; frontend and Rust
coverage gates; Clippy; production build; packaging tests; a cold real runtime
boot on all three CI operating systems; per-platform asset, updater-signature,
SHA-256 and actual OS-signature verification; and release notes supported only by
commits, tests and observed artifacts.

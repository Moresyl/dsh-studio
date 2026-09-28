# DSH Studio capability and quality roadmap

[简体中文](ROADMAP.zh-CN.md)

Updated 2026-09-28. The shipped baseline is v0.9.18. In-development work is not
released until it appears in a published version's changelog. This document
records product capabilities and acceptance boundaries, not relative rankings
or promises of zero defects.

## Implemented

| Area         | Current capability                                                                               | Boundary                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Runtime      | Supervised Harness, Node selection/provisioning, Lite and Full/Offline resources                 | Download success is not boot success; cold-runtime and packaged-resource gates remain required                        |
| Startup      | Renderer watchdog, static recovery, safe mode                                                    | Recovery must remain usable when the normal UI cannot mount                                                           |
| Profiles     | Create, copy, rename, compare, import/export and cross-window selection                          | Integrity-checked backups; selecting a configuration does not prove it boots                                          |
| Plugins      | Responsive marketplace, sources, search/filter/pagination, archive import and installed versions | Exact-version review, compatibility checks, one-use intentions, receipts and recovery; installation is not activation |
| Contracts    | Protocol 3 desktop bridge and read-only Host Protocol 1                                          | No arbitrary desktop IPC, native handles or command runner in the public host service                                 |
| Sessions     | Local search, project filters, transcripts, archive and Markdown/HTML/JSON export                | Local data remains the source of truth                                                                                |
| Usage        | Per-model pricing, monthly budget, daily trends and CSV export                                   | User-supplied prices; unpriced models are not free                                                                    |
| Terminal     | Real PTYs, Unicode, copy/paste, tabs and process ownership                                       | Failed shells retain transcripts; application exit ends child processes                                               |
| Workspaces   | Folder selection, disk admission, Git worktree discovery and creation                            | No automatic deletion of dirty or externally owned worktrees                                                          |
| Remote       | Separate LAN gateway, short-lived pairing and revocable device credentials                       | Harness remains on loopback; this is not a built-in public-internet tunnel                                            |
| Interface    | Three presentations, multiple windows, command palette and light/dark/system themes              | Keyboard/modal semantics, reduced motion and forced-colour styles                                                     |
| Diagnostics  | Bounded redacted reports, rotated logs, crash evidence and export                                | Troubleshooting reports do not imply automatic telemetry                                                              |
| Updates      | Signed updater payloads, reviewed-version confirmation and fallback metadata                     | Updater signatures are distinct from OS publisher signatures                                                          |
| Distribution | Windows/macOS/Linux jobs and package-channel manifests                                           | Generated manifests do not prove admission to every external repository                                               |

Detailed contracts live in [architecture](architecture.md),
[user guide](user-guide.md) and [plugin interoperability](plugin-interoperability.md).

## In development

- Read-only registered-worktree review with staged/unstaged diffs, untracked paths, bounded output,
  keyboard/focus regression and no destructive Git actions.

- Single, side-by-side, stacked and four-pane terminal layouts; preserve existing
  process identities and scrollback when changing layout.
- Native-backed theme, presentation, sidebar, onboarding, pricing, dismissed
  update and terminal-layout preferences. Random loopback ports must not erase
  choices after restart. Unknown keys and damaged files must fail safely.
- Real-WebView terminal regression covering five actual PTYs, route transitions,
  failed transcripts, resize safety and context-menu targeting.

These changes are recorded under **Unreleased** in the changelog. Unit tests,
native command checks and Windows WebView acceptance are distinct evidence;
none alone proves final-installer or physical macOS acceptance.

## Next priorities

### Reliability and complete user flows

- Maintain a per-page checklist for loading, empty, success, failure, cancellation,
  retry, keyboard operation, small windows and both themes.
- Exercise fresh installation and upgrades retaining profiles, plugins,
  preferences and sessions; include native pickers, tray and shutdown.
- Check profile composition, backend loading, client discovery and mounted UI
  separately. Never bypass incompatibility guards to hide a warning.
- Verify long-session responsiveness and cleanup across repeated page, profile
  and terminal transitions. Heap samples alone do not prove no leaks.

### Workspace and content depth

- Add durable worktree ownership and interrupted-operation recovery before
  removal or destructive merge/rollback actions.
- Improve workspace/session association and file/diff/test review. A remembered
  layout is neither a restored process nor a safe merge contract.
- Evaluate document previews, editable presentations and image tools against
  actual format, permission, dependency and packaged-runtime requirements.
  A plugin listing is not evidence of integrated, tested workflows.
- Evaluate optional internet access only with explicit enablement, authenticated
  pairing, resource/rate limits and revocation. Never expose the raw Harness port.

### Distribution and physical-device proof

- Verify Windows publisher signatures and macOS Developer ID/notarization on
  actual artifacts when credentials are available.
- Distinguish physical Intel/Apple Silicon acceptance from CI compilation.
- Verify external package-channel status before advertising availability.
- Mirrors must retain exact bytes and independently verifiable checksums and
  signatures; temporary proxies are not official mirrors.

## Release gates

1. Review the worktree, previous release, changelog and included commits. Stage
   only task-owned files; keep unrelated local artifacts out of commits.
2. Pass frontend/native tests and coverage, strict Clippy, lint, production build,
   public-contract, accessibility and bilingual-document gates.
3. Run multi-round actual UI/native checks against isolated data. Record failures,
   fixes, reruns and flows untested because credentials or hardware are absent.
4. Pass cross-platform cold-runtime and packaged-resource pipeline checks.
5. Verify published assets, checksums, updater manifests and signature status.
   Release notes must describe concrete verified changes and limits.

Elapsed time, green unit tests and an uploaded installer are not interchangeable
with completed acceptance. Do not publish while a known blocking regression remains.

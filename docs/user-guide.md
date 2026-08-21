# DSH Studio user guide

[简体中文](user-guide.zh-CN.md)

## First launch

Choose **Lite** for the smallest download, or **Full / Offline** when first-run setup must work without a network. Both editions use the same application identity and data directories. Full carries SHA-256-pinned Node and Harness archives; it still verifies them immediately before extraction.

1. The Environment pane finds Node.js 22.19 or newer. The app can download and verify an official runtime when none is installed.
2. The exact supported `@deepseek-ai/dsh` release is installed in app data, never into global npm.
3. The workspace must exist. On Windows, local NTFS/ReFS volumes are admitted; network, removable and FAT/exFAT volumes are blocked before launch.
4. Pick a profile and start. Harness remains bound to an OS-assigned port on `127.0.0.1`.

## Plugins

Discovery can use npm, DSH 1024Store, or a custom standard catalog. Results are indexed for ten minutes and support category filters, sorting and 25-item pages. A catalog can only suggest an exact npm target. Before any mutation, Studio resolves that version again through npm and checks package syntax and the Harness peer range. A successful market install writes a receipt with the exact source, version and integrity; the managed badge is shown only while the installed version still matches that receipt. Plugin changes have a durable before-image; an interrupted operation is rolled back on the next launch and reported in the UI.

## Presentation and desktop integration

**Compatibility** mode opens the upstream Harness interface directly. **Advanced** mode opens Studio's workspace, and the preference is shared by every window. The built-in terminal receives the selected profile/workspace plus the managed Node, Harness and pnpm tools on `PATH`. Packaged macOS and Linux builds recover only an allowlisted set of development variables from the login shell; credentials are never imported.

Harness pages can feature-detect the frozen Protocol 2 `window.dshStudio` API for notifications, pickers, badges, deep links, profile listing/selection and exact-version plugin installation/removal. The bridge accepts only the currently supervised loopback Harness origin and never exposes raw Tauri IPC or shell execution.

Completion/failure notifications for user turns and background jobs can be enabled independently in Settings. Workspace selection uses the native folder picker and also accepts a dropped folder.

## Logs and diagnostics

Export a diagnostic report from About. It includes versions, runtime, profile, recovery state and a bounded log tail while redacting tokens, authorization headers, query credentials and the home path. Persistent logs live in the app data `logs` directory.

## Updates

The app reads `latest.json` from GitHub Releases and accepts only updater artifacts verified by its embedded public key. Formal release jobs require Tauri updater signatures. Windows Authenticode and macOS Developer ID signing/notarization/stapling are added when the complete platform credentials are configured; partial credential sets fail closed.

The updater follows the ordinary Lite channel. A runtime already installed from Full remains in app data across application updates.

Windows also has a standalone Lite portable executable. The macOS Universal Lite image runs on Intel and Apple Silicon; Full / Offline images remain architecture-specific because their embedded Node runtime is native code.

## Remote access

Remote access is off by default. When enabled, the LAN gateway redeems a one-use QR code into one revocable credential per device; Harness itself remains on loopback.

See [troubleshooting](troubleshooting.md) first. If the problem remains, export a diagnostic report and attach it to an issue.

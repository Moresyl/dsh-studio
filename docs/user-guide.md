# DSH Studio user guide

[简体中文](user-guide.zh-CN.md)

## First launch

1. The Environment pane finds Node.js 22.19 or newer. The app can download and verify an official runtime when none is installed.
2. The exact supported `@deepseek-ai/dsh` release is installed in app data, never into global npm.
3. The workspace must exist. On Windows, local NTFS/ReFS volumes are admitted; network, removable and FAT/exFAT volumes are blocked before launch.
4. Pick a profile and start. Harness remains bound to an OS-assigned port on `127.0.0.1`.

## Plugins

Discovery can use npm, DSH 1024Store, or a custom standard catalog. A catalog can only suggest an exact npm target. Before any mutation, Studio resolves that version again through npm and checks package syntax and the Harness peer range. Plugin changes have a durable before-image; an interrupted operation is rolled back on the next launch and reported in the UI.

## Logs and diagnostics

Export a diagnostic report from About. It includes versions, runtime, profile, recovery state and a bounded log tail while redacting tokens, authorization headers, query credentials and the home path. Persistent logs live in the app data `logs` directory.

## Updates

The app reads `latest.json` from GitHub Releases and accepts only updater artifacts verified by its embedded public key. Formal release jobs require Windows Authenticode, macOS Developer ID signing/notarization/stapling, and Tauri updater signatures.

## Remote access

Remote access is off by default. When enabled, the LAN gateway redeems a one-use QR code into one revocable credential per device; Harness itself remains on loopback.

See [troubleshooting](troubleshooting.md) first. If the problem remains, export a diagnostic report and attach it to an issue.

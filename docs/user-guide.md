# DSH Studio user guide

[简体中文](user-guide.zh-CN.md)

## First launch

Choose **Lite** for the smallest download, or **Full / Offline** when first-run setup must work without a network. Both editions use the same application identity and data directories. Full carries SHA-256-pinned Node and Harness archives; it still verifies them immediately before extraction.

1. The Environment pane finds Node.js 22.19 or newer. The app can download and verify an official runtime when none is installed.
2. The exact supported `@deepseek-ai/dsh` release is installed in app data, never into global npm.
3. The workspace must exist. On Windows, local NTFS/ReFS volumes are admitted; network, removable and FAT/exFAT volumes are blocked before launch.
4. Pick a profile and start. Harness remains bound to `127.0.0.1`. The default
   asks the OS for a random port; Settings can persist a fixed port from 1024 to
   65535 when a stable loopback origin is needed. Studio checks a fixed port
   before starting Node and reports an occupied port instead of silently moving.

## Plugins

Discovery can use npm, DSH 1024Store, the rate-limited reviewed dshfind catalog, or a custom standard catalog. The Sources tab also opens [DSH Hub](https://dsh-hub.org/) for community discovery: copy a listed npm package name back into Studio search and the same native review applies. DSH Hub currently exposes a website directory rather than Studio's public catalog Schema 1.0.0 endpoint, so Studio does not scrape its HTML or treat the homepage as an install authority. Results are indexed for ten minutes and support category filters, sorting and 25-item pages. A catalog can only suggest an exact npm target. Before any mutation, Studio resolves that version again through npm and checks package syntax and the Harness peer range. A successful market install writes a receipt with the exact source, version and integrity; the managed badge is shown only while the installed version still matches that receipt. Plugin changes have a durable before-image; an interrupted operation is rolled back on the next launch and reported in the UI.

## Presentation and desktop integration

**Compatibility** opens the upstream Harness interface directly. **Extended**
keeps the full upstream interface and adds a compact native toolbar for terminal,
sessions, plugins, Profile and workspace actions. **Advanced** opens Studio's
complete workspace. The preference is shared by every window. The built-in
terminal receives the selected Profile/workspace plus the managed Node, Harness
and pnpm tools on `PATH`. Packaged macOS and Linux builds recover only an
allowlisted set of development variables from the login shell; credentials are
never imported.

Harness pages can feature-detect the frozen Protocol 3 `window.dshStudio` API for notifications, pickers, badges, deep links, profile listing/selection, exact-version plugin installation/removal, and native workspace admission/drop signals. The bridge accepts only the currently supervised loopback Harness origin and never exposes raw Tauri IPC or shell execution.

Harness Host plugins can separately feature-detect read-only Host Protocol 1 for
the active Studio/Harness versions and a bounded Profile roster. It provides no
native handles, command runner, package mutation, or Profile mutation. See the
[plugin interoperability contract](plugin-interoperability.md).

Completion/failure notifications for user turns and background jobs can be enabled independently in Settings. Workspace selection uses the native folder picker and also accepts a dropped folder.

## Logs and diagnostics

About can copy a public-safe diagnostic summary or export a 50 MiB-bounded ZIP. The ZIP contains build, runtime, profile and recovery state, recent redacted logs, Rust/WebView crash evidence, and native minidumps written for Studio panics on Windows; safe, bounded system crash reports already present on Windows/macOS are included too. Nothing is uploaded automatically. Binary dumps may contain process memory, so inspect the archive before sharing it.

If Studio cannot reach a window, run its executable with `--export-diagnostics`. The command exits before Tauri or Harness starts and prints the absolute path of a uniquely named ZIP. For example, use `.\dsh-studio.exe --export-diagnostics` beside the Windows portable executable, `"/Applications/DSH Studio.app/Contents/MacOS/dsh-studio" --export-diagnostics` on macOS, or `dsh-studio --export-diagnostics` on Linux.

Persistent logs live in the app data `logs` directory. A file rotates at 10 MiB, logs older than seven days are removed, and the directory is capped at 200 MiB. Settings can select Debug, Info, Warning or Error persistence; the live console is never filtered.

If the React renderer does not commit within 12 seconds, or the startup crash
hook fires first, Studio opens a static native recovery window that does not load
React, Harness, Node, or network resources. It can retry the renderer, export a
redacted diagnostic archive, or quit.

## Updates

The app reads `latest.json` from GitHub Releases and falls back to the validated official Pages manifest when the primary feed is unavailable. It accepts only updater artifacts verified by its embedded public key. Formal release jobs require Tauri updater signatures. Windows Authenticode and macOS Developer ID signing/notarization/stapling are added when the complete platform credentials are configured; partial credential sets fail closed.

The updater follows the ordinary Lite channel. A runtime already installed from Full remains in app data across application updates.

Windows also has a standalone Lite portable executable. The macOS Universal Lite image runs on Intel and Apple Silicon; Full / Offline images remain architecture-specific because their embedded Node runtime is native code.

## Remote access

Remote access is off by default. When enabled, the LAN gateway redeems a one-use QR code into one revocable credential per device; Harness itself remains on loopback.

See [troubleshooting](troubleshooting.md) first. If the problem remains, export a diagnostic report and attach it to an issue.

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

## Harness versions

In Environment, check published Harness versions, choose an exact release, and
select **Install and verify** to upgrade or downgrade. Switching stops the running
Harness. Studio installs into a separate directory and checks its integration,
loopback HTTP startup and Host protocol with a temporary official Profile before
activation. Failed installation or verification preserves the previous runtime;
start it again from the control panel. Existing Profiles and sessions are retained.

The **Studio** label identifies the bundled tested release. Other upstream
versions may fail verification when their internal interfaces change; being listed
on npm does not guarantee compatibility with Studio or third-party plugins.
Choose the Studio-labelled version to return to the bundled compatibility baseline.
Full / Offline can install that baseline offline; selecting another version needs
network access. Old runtime markers remain readable, and Repair targets the last
successfully verified version. Do not manually replace packages inside the managed
runtime directory.

Harness 0.1.2 and later authenticate the web UI with a per-boot token exchanged
for a `SameSite=Strict` session cookie. The Studio shell serves itself from the
same loopback site (`http://127.0.0.1`), so the embedded window holds and sends
that cookie exactly like a browser tab — no Harness patching is involved.

## Session history

Search saved conversations by their content, open a matching excerpt, and export
the native transcript as Markdown, HTML or JSON. Long transcripts display up to
120 messages per segment; the footer goes to earlier, later, first or latest
messages. Search opens the segment containing the selected match. Pagination
does not limit the exported transcript. Archiving hides a conversation from the
active list without deleting its Harness log; restore it from the Archived tab.

To bound memory use, each log reads at most 64 MiB of compressed data and 32 MiB
of decoded text (plain logs use the 32 MiB text limit). A size-limited log is
marked **Partial**: its search results, usage totals and exports cover only the
loaded portion. Markdown/HTML exports include a warning; JSON includes
`card.limited`. The original log is not modified.

## Plugins

Discovery can use npm, DSH 1024Store, the rate-limited reviewed dshfind catalog, or a custom standard catalog. The Sources tab also opens [DSH Hub](https://dsh-hub.org/) for community discovery: copy a listed npm package name back into Studio search and the same native review applies. DSH Hub currently exposes a website directory rather than Studio's public catalog Schema 1.0.0 endpoint, so Studio does not scrape its HTML or treat the homepage as an install authority. Results are indexed for ten minutes and support category filters, sorting and 25-item pages. A catalog can only suggest an exact npm target. Before any mutation, Studio resolves that version again through npm and checks package syntax and the Harness peer range. A successful market install writes a receipt with the exact source, version and integrity; the managed badge is shown only while the installed version still matches that receipt. Plugin changes have a durable before-image; an interrupted operation is rolled back on the next launch and reported in the UI.

## Presentation and desktop integration

The terminal layout selector offers a single pane, side-by-side panes, stacked
panes and a four-pane grid. Open shells explicitly with **New terminal**; layout
changes never start or restart a process. Tabs beyond the visible group remain
available on the tab strip. Selecting a tab brings its group into view. Click a
pane or its header to select it; the context menu acts on the clicked pane.
Layout changes and navigation preserve live transcripts. A failed shell retains
its transcript without sending input or resize commands to the exited process.
Only the layout preference is saved across application restarts, not shell
processes or transcripts. Hiding the main window in the tray keeps shells running;
quitting the application ends them.

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

Portable Agent Presets use the `.dshpreset` file type. Open one from the operating
system, drop it anywhere on Studio, or choose **Import** in the preset picker.
Studio validates the package manifest and every recorded SHA-256 before showing
its identity, file count, and unpacked size. Import happens only after an explicit
trust confirmation; declining or failing validation leaves the package and the
current Profile unchanged.

Completion/failure notifications for user turns and background jobs can be enabled independently in Settings. Workspace selection uses the native folder picker and also accepts a dropped folder.

## Local presentations (development branch)

These controls are under acceptance and are not included in the published v0.9.19.

Open **Presentations**, choose **New presentation**, preview a starting template,
then create the document. Select objects to edit their properties; drag them to
move or use arrow keys for small adjustments (Shift for larger steps). Save stores
the editable source in the local library. Export PPTX creates a separate editable
PowerPoint file from the current snapshot; it does not save later edits to the
local source automatically.

**Save a copy** includes current edits and opens a newly saved independent document.
The original library file remains unchanged, even if the current edits had not yet
been saved there. Rename the copy in its title field if desired. A failed copy keeps
the current document available. Save/copy/export validate unfinished fields first;
correct invalid input or press Escape to discard that field's pending input.

Do not treat the editor's in-memory draft as crash recovery. Save important edits.
PPTX import and imported personal templates are not available in this branch yet.

## Worktree review

Settings lists the current repository's Git worktrees and can create an isolated branch/directory.
**Review changes** opens a read-only view of changed paths and separate staged/unstaged diffs.
The two status columns distinguish index changes from working-copy changes; untracked paths are
listed without reading their contents. The current-worktree label follows the selected workspace,
including linked worktrees. Refresh after edits because this is not a live editor.

Each diff is limited to 256 KiB and 5,000 lines. Oversized diffs are explicitly withheld, not silently
shown as complete; the file list remains available. More than 5,000 changed paths or oversized Git
status output requires review with Git directly. Binary changes use Git's binary-difference notice.
Studio does not run external diff/text-conversion tools or filesystem-monitor hooks for these reads.
Review never stages, resets, merges, deletes or cleans files, and does not display uncommitted work
from unrelated repositories. Use your existing Git workflow for those actions.

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

Windows also has a Lite portable ZIP. Extract the whole archive and launch `dsh-studio.exe`; keep its `dist/` folder beside the executable. Runtime data still uses Studio's normal application-data location, so this is an installation-free distribution, not a separate profile on a USB drive. The macOS Universal Lite image runs on Intel and Apple Silicon; Full / Offline images remain architecture-specific because their embedded Node runtime is native code.

## Remote access

Remote access is off by default. When enabled, the LAN gateway redeems a one-use QR code into one revocable credential per device; Harness itself remains on loopback.

See [troubleshooting](troubleshooting.md) first. If the problem remains, export a diagnostic report and attach it to an issue.

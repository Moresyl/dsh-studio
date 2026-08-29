# Troubleshooting

[简体中文](troubleshooting.zh-CN.md)

## Plugin install reports 404 / “No authorization header”

If the log names `@deepseek-ai/dsh@0.0.1-rc.1` and a missing `@deepseek-ai/dsh-code-runtime-worker`, the failure is the old upstream dependency graph, not a missing login. Current Studio pins the qualified `0.1.1-rc.2` family. Use **Repair** in Environment to atomically replace the stale runtime.

If it continues, check whether npm is configured to use an incomplete mirror. Public packages do not need an Authorization header; only a genuinely private scope does. Retry with `https://registry.npmjs.org/`, then export diagnostics rather than deleting a live profile by hand.

## An install was interrupted

Harness is installed into staging and promoted only after validation. Plugin mutations also preserve a before-image. Restart Studio to run recovery. If Environment reports that recovery failed, use Repair and attach the exported diagnostic report to an issue.

## Harness remains on “Installing”

Studio installs its qualified runtime from the official npm registry and shows native lifecycle stages in the console. A request that produces no output for 120 seconds, or an install that exceeds 20 minutes, is stopped instead of spinning forever. Check the displayed failure, retry on a working connection, or use Full / Offline. If the window cannot start, run the executable with `--export-diagnostics` and attach the resulting ZIP.

If npm finishes but Contract 2 rejects the runtime, use Studio v0.7.2 or newer and click Repair. These versions materialize the bundled Studio integration instead of leaving a Windows junction into the temporary install source, and the error lists the exact missing contract condition when validation still fails.

## Managed Harness modules are unavailable

Older Studio builds depended entirely on the upstream per-package links under `$DSH_HOME/profiles/node_modules`. Windows can intermittently refuse to traverse these junctions, producing `ERR_MODULE_NOT_FOUND` even though the same managed package exists. Current builds preserve normal Profile resolution, then fall back only missing `@deepseek-ai/*` imports to the qualified managed Harness. The selected Profile, its installed package versions and third-party plugins remain authoritative and are not deleted.

Restart once after upgrading so the Studio-owned resolver is materialized. If the message still appears on a current build, use **Repair** in Environment and export diagnostics; do not delete the Profile by hand.

## Workspace was refused

On Windows, move the project to a fixed local NTFS/ReFS volume. Mapped network drives, removable media, FAT32 and exFAT cannot reliably preserve the links, locks and atomic replacements package tools require.

## Windows/macOS blocks an installer

Install only from a formal Release or a documented package channel and compare `SHA256SUMS.txt`. Formal releases must pass platform-signature verification. Do not bypass an unknown-publisher warning; report the asset name and digest.

## Node was not found

Use the Environment pane to provision an official Node runtime. On a network that blocks the download, install a Node version meeting the displayed minimum and inspect again.

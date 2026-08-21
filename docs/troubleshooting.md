# Troubleshooting

[简体中文](troubleshooting.zh-CN.md)

## Plugin install reports 404 / “No authorization header”

If the log names `@deepseek-ai/dsh@0.0.1-rc.1` and a missing `@deepseek-ai/dsh-code-runtime-worker`, the failure is the old upstream dependency graph, not a missing login. Current Studio pins the qualified `0.1.0-rc.8` family. Use **Repair** in Environment to atomically replace the stale runtime.

If it continues, check whether npm is configured to use an incomplete mirror. Public packages do not need an Authorization header; only a genuinely private scope does. Retry with `https://registry.npmjs.org/`, then export diagnostics rather than deleting a live profile by hand.

## An install was interrupted

Harness is installed into staging and promoted only after validation. Plugin mutations also preserve a before-image. Restart Studio to run recovery. If Environment reports that recovery failed, use Repair and attach the exported diagnostic report to an issue.

## Workspace was refused

On Windows, move the project to a fixed local NTFS/ReFS volume. Mapped network drives, removable media, FAT32 and exFAT cannot reliably preserve the links, locks and atomic replacements package tools require.

## Windows/macOS blocks an installer

Install only from a formal Release or a documented package channel and compare `SHA256SUMS.txt`. Formal releases must pass platform-signature verification. Do not bypass an unknown-publisher warning; report the asset name and digest.

## Node was not found

Use the Environment pane to provision an official Node runtime. On a network that blocks the download, install a Node version meeting the displayed minimum and inspect again.

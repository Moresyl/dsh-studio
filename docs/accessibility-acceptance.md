# Accessibility acceptance

[简体中文](accessibility-acceptance.zh-CN.md)

DSH Studio treats accessibility as a release contract, not a one-time visual
review. `pnpm verify:a11y` statically rejects unnamed buttons, keyboard-inert
`role="button"` controls, and unnamed or non-modal dialogs. The same gate also
requires visible focus, reduced-motion, and forced-colour rules and runs inside
`pnpm test:release`.

Automation catches structural regressions; it cannot prove the quality of a
screen-reader announcement or an operating-system rendering. Perform this short
manual matrix on each release candidate and attach the result to its build:

| Area | Acceptance |
| --- | --- |
| Keyboard | Reach every command, tab, menu, switch, list entry and dialog without a pointer. Focus remains visible, modal focus is trapped, Escape closes, and focus returns to the invoking control. |
| Screen reader | Verify window/pane headings, current tab, switches, status changes, error details, destructive confirmations and terminal labels with Narrator on Windows. Use VoiceOver on real macOS hardware when available. |
| 200% zoom | At 200% OS text/display scaling, no required control or error is clipped; panes remain scrollable and dialogs remain operable. |
| Reduced motion | With the OS motion preference enabled, transitions and animations settle immediately without hiding content or focus. |
| High contrast | In Windows High Contrast, boundaries, focus, selected/current state, disabled state and failure controls remain distinguishable without relying on authored colours. |
| Error recovery | Trigger an invalid terminal start, occupied Harness port, failed plugin preview/install and updater network failure. Each explicit action shows a selectable, copyable dialog; background refresh remains non-modal. |

For terminal content, verify keyboard copy/paste, the accessible tab names, and
that closing one tab moves focus to a surviving control. xterm's stream content
is third-party UI; native DSH Studio chrome around it remains covered by the
contract above.

No Apple device is currently available. macOS builds and headless tests are
evidence of compatibility, not evidence that VoiceOver, zoom, notifications,
the terminal, or installer flows passed physical-device acceptance.

## Isolated desktop regression

Build a debug QA app with a separate Tauri identifier, product name and deep-link
scheme. Launch it with dedicated `DSH_STUDIO_DATA_DIR` and `DSH_HOME` directories
and `DSH_STUDIO_WEBVIEW_DEBUG_PORT=9223`; do not reuse an everyday installation's
data. The runtime must already be installed in that QA data directory. The
runners verify the live profile path before changing anything.

```powershell
node .github/scripts/desktop-regression.mjs --port=9223 --minutes=20 --qa-home=D:/qa/home --output=D:/qa/ui-results
node .github/scripts/desktop-ipc-regression.mjs D:/qa/home D:/qa/native-results 9223
node .github/scripts/desktop-terminal-regression.mjs D:/qa/home D:/qa/terminal-results 9223
node .github/scripts/desktop-runtime-regression.mjs D:/qa/home D:/qa/runtime-results 9223
node .github/scripts/desktop-preferences-regression.mjs D:/qa/home D:/qa/preference-results 9223
node .github/scripts/desktop-keyboard-regression.mjs D:/qa/home D:/qa/keyboard-results 9223
node .github/scripts/desktop-worktree-regression.mjs D:/qa/home D:/qa/worktree-results 9223
node .github/scripts/desktop-worktree-failure-regression.mjs D:/qa/home D:/qa/worktree-failure-results 9223
node .github/scripts/desktop-session-regression.mjs D:/qa/home D:/qa/session-results 9223 bounded
node .github/scripts/desktop-session-regression.mjs D:/qa/home D:/qa/session-limit-results 9223 limited
```

The UI runner checks eight shell pages, horizontal overflow, plugin-card
semantics, modal focus/Escape restoration and uncaught WebView exceptions. Timed
runs retain screenshots and DOM/heap measurements; those samples do not by
themselves prove the absence of leaks. The native runner exercises the actual
WebView ACL, profile round trips, custom preset packages, session search/export/
archive and a real PTY. It creates unique QA fixtures and removes its temporary
profiles, fixtures and terminal afterward. Exports and the result report remain
under the requested output directory. Run all runners sequentially and do not
operate the same QA window during the UI run.

These checks complement the manual matrix; they do not cover model-provider
credentials, real external SSH accounts, Narrator or physical macOS hardware.

The keyboard runner requires one isolated QA window. It checks visible enabled
selectors across the eight pages using actual CDP key events: arrow wrapping,
Home/End, active-item visibility, viewport bounds, Escape focus return and Tab
dismissal without changing selections. It also opens and dismisses the command
palette. Its report records the actual option counts; run after catalog loading
to exercise long categories rather than only the initial placeholder.

The terminal runner also refuses a QA window with existing live shells. It opens
five real PTYs through the UI, verifies layout groups, output retention, route
round trips, a failed shell transcript, resize safety and context-menu targeting,
then closes its own terminals. Run it separately from other UI runners. Its
layout-preference check does not prove application-restart restoration; verify
that separately and confirm that no shell is launched automatically.

The runtime runner interleaves real start/stop transitions with visible re-checks,
then compares supervisor state with the enabled UI action. It restores the initial
running/stopped state and never sends a model request. The preference runner
checks durable writes and same-window reloads, not full-process restart by itself.
Worktree runners require Harness to be stopped, retain isolated Git evidence and
restore the selected workspace. The failure runner temporarily makes only its
own fixture's Git directory unavailable, then restores it and retries.

Session runners create exclusive local fixtures, check 4,000-message pagination
or a 33 MiB partial log, and remove those fixtures after checking exports and
small-window/high-contrast presentation. Do not count an interrupted timed run
as a completed soak; restart the full duration after changing the candidate.

Verify viewport dimensions and capture reduced-motion or forced-colour mode in
the same CDP connection, before its overrides expire. These browser simulations
do not replace manual acceptance using Windows system settings:

```powershell
node .github/scripts/desktop-ui-acceptance.mjs 9223 viewport 900 620 D:/qa/contrast.png forced-colors
node .github/scripts/desktop-ui-acceptance.mjs 9223 viewport 900 620 D:/qa/motion.png reduced-motion
```

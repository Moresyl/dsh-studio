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
data. The runtime must already be installed in that QA data directory. Both
runners verify the live profile path before changing anything.

```powershell
node .github/scripts/desktop-regression.mjs --port=9223 --minutes=20 --qa-home=D:/qa/home --output=D:/qa/ui-results
node .github/scripts/desktop-ipc-regression.mjs D:/qa/home D:/qa/native-results 9223
```

The UI runner checks seven shell pages, horizontal overflow, plugin-card
semantics, modal focus/Escape restoration and uncaught WebView exceptions. Timed
runs retain screenshots and DOM/heap measurements; those samples do not by
themselves prove the absence of leaks. The native runner exercises the actual
WebView ACL, profile round trips, custom preset packages, session search/export/
archive and a real PTY. It creates unique QA fixtures and removes its temporary
profiles, fixtures and terminal afterward. Exports and the result report remain
under the requested output directory. Run the two sequentially and do not
operate the same QA window during the UI run.

These checks complement the manual matrix; they do not cover model-provider
credentials, real external SSH accounts, Narrator or physical macOS hardware.

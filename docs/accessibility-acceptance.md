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

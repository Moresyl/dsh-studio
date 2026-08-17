/**
 * Which desktop this window is on.
 *
 * The webview is the only thing that knows without an extra plugin round-trip,
 * and the answer never changes at runtime — so it is read once.
 */
const agent = navigator.userAgent

export const isMac = /Mac OS X/.test(agent) && !/Mobile/.test(agent)
export const isWindows = /Windows NT/.test(agent)
export const isLinux = !isMac && !isWindows

/**
 * Whether the shell draws its own window buttons.
 *
 * macOS keeps its traffic lights, so there is nothing to draw — only room to
 * leave for them.
 */
export const drawsWindowControls = !isMac

/**
 * How this platform writes the modifier that shortcuts hang off.
 *
 * Spelled the way the platform spells it, because a tooltip that says "Ctrl" on
 * a Mac is a tooltip written by someone who has never used one.
 */
export const ACCELERATOR = isMac ? '⌘' : 'Ctrl+'

/**
 * And the second modifier, for the few shortcuts that need both.
 *
 * Written the same way round: macOS runs its modifiers together as symbols,
 * everywhere else spells them out and joins them with a plus.
 */
export const SHIFT = isMac ? '⇧' : 'Shift+'

/** The backdrop materials `src-tauri/src/material.rs` knows how to ask for. */
export type Material = 'micaAlt' | 'mica' | 'acrylic' | 'vibrancy'

declare global {
  interface Window {
    /** Published before this bundle runs; see `announce` in `window.rs`. */
    __DSH_MATERIAL__?: unknown
    /** Likewise: whether this launch was the login item's, not a person's. */
    __DSH_STANDBY__?: unknown
  }
}

/**
 * Whether this launch is one nobody is watching.
 *
 * The login item starts the app with `--hidden`, and the window is built
 * hidden — so the frontend, which is what reveals it once it has painted, has
 * to know before it paints that it should not.
 */
export const standby = window.__DSH_STANDBY__ === true

const isMaterial = (value: unknown): value is Material =>
  value === 'micaAlt' || value === 'mica' || value === 'acrylic' || value === 'vibrancy'

/**
 * Which material the window was given, if any.
 *
 * Rust decides — the question is a Windows build number on one platform, a
 * compositor's cooperation on another — and writes the answer into the page
 * before this bundle runs. So it is a constant here rather than something to
 * await: the grounds a glass window paints are not the ones an opaque window
 * paints, and there must be no frame in which the wrong set is on screen.
 *
 * `null` outside the app as well, which is what the browser-hosted capture
 * harness in `media/` gets — and correctly, since there is nothing behind it.
 */
export const material: Material | null = isMaterial(window.__DSH_MATERIAL__)
  ? window.__DSH_MATERIAL__
  : null

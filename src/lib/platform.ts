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

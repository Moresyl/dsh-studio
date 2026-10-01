/**
 * The theme conversation between this window and the Harness page it frames.
 *
 * Harness has an Appearance setting of its own — Light, Dark, Follow system — and
 * so does this window. Two switches for one thing is a fight waiting to happen,
 * and it did: pick Light in Harness under a dark window and half the dialog was
 * drawn with the other theme's text colours. So they are one setting with two
 * doors. The window tells the page its choice, and the page tells the window when
 * the choice was made at its door.
 *
 * Both directions carry the *preference* (what was picked, including "system")
 * and not just the scheme it resolves to. A page told only "dark" would pin
 * itself to dark and stop following the machine at sunset, which is the thing
 * "system" exists to do.
 *
 * Kept as plain functions over plain data because it is a wire format: the other
 * half of it is a script that runs inside Harness (see
 * `src-tauri/runtime-contract/dsh-studio-integration/lib/client.js`), and the
 * only thing the two halves share is this shape.
 */

export type ThemePreference = 'system' | 'light' | 'dark'

const PREFERENCES: readonly string[] = ['system', 'light', 'dark']

/** What the window tells the page: the scheme to draw, and the preference behind it. */
export function themeMessage(preference: ThemePreference, dark: boolean) {
  return {
    type: 'dsh-studio:theme',
    theme: dark ? 'dark' : 'light',
    preference,
  } as const
}

/**
 * The preference the page is asking the window to adopt, or `null` for any other
 * message — including a well-formed one with a value this window does not have,
 * which is refused rather than guessed at.
 */
export function readPreferenceRequest(data: unknown): ThemePreference | null {
  if (typeof data !== 'object' || data === null) return null
  const { type, preference } = data as { type?: unknown; preference?: unknown }
  if (type !== 'dsh-studio:theme-preference') return null
  return typeof preference === 'string' && PREFERENCES.includes(preference)
    ? (preference as ThemePreference)
    : null
}

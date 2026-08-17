/**
 * Light or dark, and who decides.
 *
 * Three choices rather than two. A desktop application that only offers a
 * switch has quietly taken the decision away from the system: the user set
 * their machine to turn dark at sunset, and this one window would stop
 * following. So "system" is a real option, it is the default, and it keeps
 * tracking the preference for as long as it is the one selected.
 *
 * The choice is written to `data-theme` on the root element and nowhere else.
 * Every colour in the app is a custom property, so re-pointing them there is
 * the whole of the theme — no component knows which one it is drawing in.
 *
 * Two things hang off the same root element and belong here for that reason:
 * `data-material`, which is a fact about the window rather than a choice and so
 * is written once, and the compositor, which has to be moved by hand because
 * parts of the window frame are drawn by the system and not by this stylesheet.
 */
import { create } from 'zustand'

import { announce, onSharedChange, windowMaterial } from '@/lib/ipc'
import { material } from '@/lib/platform'

export type Theme = 'system' | 'light' | 'dark'

/** Namespaced, because a webview's storage is shared with whatever it hosts. */
const KEY = 'dsh-studio.theme'

const isTheme = (value: unknown): value is Theme =>
  value === 'system' || value === 'light' || value === 'dark'

/**
 * What was chosen last time, or the system's answer.
 *
 * Storage can throw rather than merely be empty — a webview started with it
 * disabled does exactly that — and a theme is not worth failing to start over.
 */
function remembered(): Theme {
  try {
    const saved: unknown = window.localStorage.getItem(KEY)
    return isTheme(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

/**
 * The system's answer, kept live rather than read once.
 *
 * Held onto because it is needed twice: to resolve `system` into a real light or
 * dark for the compositor, and to notice when that resolution changes under a
 * window nobody has touched.
 */
const prefersDark =
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null

/** What the choice actually comes out as, right now. */
const isDark = (theme: Theme): boolean =>
  theme === 'system' ? (prefersDark?.matches ?? true) : theme === 'dark'

/**
 * Put the choice where the stylesheet can see it.
 *
 * `system` removes the attribute instead of writing one, which hands the
 * question back to `prefers-color-scheme` — the only way to keep following a
 * preference that changes while the window is open.
 *
 * The compositor cannot be handed anything: it needs the resolved answer, and it
 * needs to be told. That is not a duplicate of the attribute above — the frame's
 * resize border and its snap-layouts flyout are drawn by Windows, and a window
 * whose content went light while its own border stayed dark looks broken in a
 * way neither half is responsible for.
 */
function apply(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = theme

  if (material !== null) void windowMaterial(isDark(theme))
}

interface ThemeState {
  theme: Theme
  choose: (theme: Theme) => void
}

export const useTheme = create<ThemeState>((set) => ({
  theme: remembered(),

  choose: (theme) => {
    apply(theme)
    try {
      window.localStorage.setItem(KEY, theme)
    } catch {
      // Unwritable storage costs the choice at the next start, which is worth
      // less than the window that refused to change colour.
    }
    set({ theme })
    // Storage is shared between the windows and nothing watches it: the DOM's
    // own `storage` event does not reliably cross webviews on every platform
    // this ships to. So the windows are told. This is the one choice that is on
    // screen in all of them at once, and one of them still drawing the old
    // theme reads as a window that has stopped working.
    void announce('theme')
  },
}))

// A fact and not a choice, so it is written once and never removed. It is what
// turns the window's grounds to glass, and it has to be true before the first
// paint or there is a frame of opaque chrome over a transparent window.
if (material !== null) document.documentElement.dataset.material = material

// Before React draws anything: a window that renders dark and turns light a
// frame later is worse than one that was never asked to.
apply(useTheme.getState().theme)

// While `system` is the choice, the preference changing is the choice changing.
// The stylesheet notices by itself; the compositor does not.
prefersDark?.addEventListener('change', () => {
  if (useTheme.getState().theme === 'system') apply('system')
})

// Somebody chose a theme, possibly in this window. Read the choice back out of
// storage rather than taking it from the signal, and stop where it is already
// the one on screen — which is what this window's copy of its own announcement
// comes to, and what a second window that was already following makes of a
// switch to `system`.
void onSharedChange((subject) => {
  if (subject !== 'theme') return
  const theme = remembered()
  if (theme === useTheme.getState().theme) return
  apply(theme)
  useTheme.setState({ theme })
})

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
 */
import { create } from 'zustand'

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
 * Put the choice where the stylesheet can see it.
 *
 * `system` removes the attribute instead of writing one, which hands the
 * question back to `prefers-color-scheme` — the only way to keep following a
 * preference that changes while the window is open.
 */
function apply(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = theme
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
  },
}))

// Before React draws anything: a window that renders dark and turns light a
// frame later is worse than one that was never asked to.
apply(useTheme.getState().theme)

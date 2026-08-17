/**
 * Whether a newer build of this shell has been published.
 *
 * This is the one request the app makes without being asked, and it is worth
 * being precise about what that costs: a single GET to the release feed, no
 * account, no identifier, nothing sent about the machine. What it buys is the
 * only thing a version number is good for — knowing that the bug you are
 * working around was fixed last week.
 *
 * A notice that cannot be waved away is an advertisement, so the dismissal is
 * per version: say no to 0.3.0 and it stays gone until 0.4.0 exists.
 */
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import type { Release } from '@/lib/ipc'

const DISMISSED_KEY = 'dsh-studio:update:dismissed'

/** Wait before the first check, so a launch spends its first seconds launching. */
const FIRST_CHECK_MS = 4_000

/** And again at this interval, for the window that stays open for days. */
const RECHECK_MS = 6 * 60 * 60 * 1000

interface UpdateState {
  release: Release | null
  checking: boolean
  /** Only ever set by a check the user asked for. */
  error: string | null
  /** The version already waved away, remembered across restarts. */
  dismissed: string | null
  check: (quiet?: boolean) => Promise<void>
  dismiss: () => void
}

export const useUpdate = create<UpdateState>((set, get) => ({
  release: null,
  checking: false,
  error: null,
  dismissed: readDismissed(),

  /**
   * `quiet` is for the checks nobody asked for. A laptop that is offline, or a
   * machine with no Node yet, is not a situation to report — it is Tuesday.
   */
  check: async (quiet = false) => {
    if (get().checking) return
    set({ checking: true, error: null })
    try {
      set({ release: await ipc.checkUpdate() })
    } catch (cause) {
      if (!quiet) set({ error: describe(cause) })
    } finally {
      set({ checking: false })
    }
  },

  dismiss: () => {
    const version = get().release?.version
    if (!version) return
    writeDismissed(version)
    set({ dismissed: version })
  },
}))

/** Whether there is something worth a line in the status bar. */
export const isAnnounceable = (state: UpdateState): boolean =>
  state.release !== null && state.release.newer && state.release.version !== state.dismissed

/**
 * Start checking, and keep checking.
 *
 * Returns the way to stop, like the other subscriptions the window owns.
 */
export const watchForUpdates = (): (() => void) => {
  const check = () => void useUpdate.getState().check(true)
  const first = window.setTimeout(check, FIRST_CHECK_MS)
  const repeat = window.setInterval(check, RECHECK_MS)

  return () => {
    window.clearTimeout(first)
    window.clearInterval(repeat)
  }
}

// Storage can be unavailable — a webview started with it disabled throws on
// access rather than returning null. The honest fallback is to have no memory
// of a dismissal: the notice comes back, which is the harmless direction to
// fail in.
function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

function writeDismissed(version: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    // Then it is dismissed for this run only, which is still what was asked.
  }
}

/**
 * Whether a newer build of this shell has been published.
 *
 * This is the one request the app makes without being asked, and it is worth
 * being precise about what that costs: public release metadata requests, no
 * account, no identifier, nothing sent about the machine. What it buys is the
 * only thing a version number is good for — knowing that the bug you are
 * working around was fixed last week.
 *
 * A notice that cannot be waved away is an advertisement, so the dismissal is
 * per version: say no to 0.3.0 and it stays gone until 0.4.0 exists.
 */
import { create } from 'zustand'

import {
  cancelUpdate,
  checkForUpdate,
  discardReview,
  installUpdate,
  UpdateCancelled,
  type DownloadProgress,
  type Release,
} from '@/lib/updater'
import { reportFailure } from '@/state/failure'
import { readPreference, savePreference } from '@/lib/preferences'
import { usePresentationEditor } from '@/state/presentation-editor'
import { t } from '@/lib/i18n'

const DISMISSED_KEY = 'dsh-studio:update:dismissed'

/** Wait before the first check, so a launch spends its first seconds launching. */
const FIRST_CHECK_MS = 4_000

/** And again at this interval, for the window that stays open for days. */
const RECHECK_MS = 6 * 60 * 60 * 1000

/** One native updater request per window. A manual check that arrives while the
 * launch-time check is running joins this promise, so its result or failure is
 * still visible instead of the click being silently discarded. */
let activeCheck: Promise<void> | null = null
let installationGeneration = 0

interface UpdateState {
  release: Release | null
  /** A successful check has completed, including the up-to-date result. */
  checked: boolean
  checking: boolean
  manualChecking: boolean
  checkedAt: number | null
  installing: boolean
  targetRelease: Release | null
  installation: Release | null
  cancelling: boolean
  progress: DownloadProgress | null
  /** Only ever set by a check the user asked for. */
  error: string | null
  /** The version already waved away, remembered across restarts. */
  dismissed: string | null
  check: (quiet?: boolean) => Promise<void>
  install: () => Promise<void>
  installVersion: (release: Release) => Promise<void>
  runInstall: (release: Release, target: 'latest' | 'selected') => Promise<void>
  cancelInstall: () => Promise<void>
  dismiss: () => void
}

export const useUpdate = create<UpdateState>((set, get) => ({
  release: null,
  checked: false,
  checking: false,
  manualChecking: false,
  checkedAt: null,
  installing: false,
  targetRelease: null,
  installation: null,
  cancelling: false,
  progress: null,
  error: null,
  dismissed: readDismissed(),

  /**
   * `quiet` is for the checks nobody asked for. A laptop that is offline is not
   * a situation to report — it is Tuesday.
   */
  check: async (quiet = false) => {
    if (get().installing) return
    if (!quiet && get().manualChecking) return
    if (!quiet) set({ manualChecking: true })
    let operation = activeCheck
    if (operation === null) {
      set({ checking: true, error: null })
      operation = (async () => {
        const release = await checkForUpdate()
        void discardReview(get().release)
        set({ release, checked: true, checkedAt: Date.now() })
      })().finally(() => {
        activeCheck = null
        set({ checking: false })
      })
      activeCheck = operation
    }
    try {
      await operation
    } catch (cause) {
      if (!quiet) {
        // An earlier successful result is stale once a manual refresh fails.
        // Keeping it visible makes the user think the feed was checked now and
        // can offer an installer that may no longer exist.
        void discardReview(get().release)
        set({ release: null, checked: false, error: reportFailure(cause) })
      }
    } finally {
      if (!quiet) set({ manualChecking: false })
    }
  },

  install: async () => {
    const release = get().release
    if (release) await get().runInstall(release, 'latest')
  },

  installVersion: async (release) => get().runInstall(release, 'selected'),

  runInstall: async (release, target) => {
    if (get().installing || get().checking) return
    // Commit an input's pending value before deciding whether restarting is safe.
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement)
      document.activeElement.blur()
    if (!usePresentationEditor.getState().lockForUpdate()) {
      set({ error: reportFailure(new Error(t('deck.saveBeforeUpdate'))) })
      return
    }
    ++installationGeneration
    set({
      installing: true,
      targetRelease: release,
      installation: null,
      cancelling: false,
      progress: { downloaded: 0, total: null, phase: 'checking' },
      error: null,
    })
    try {
      const installed = await installUpdate(
        release,
        (progress) => set({ progress }),
        target,
        (review) => {
          if (get().cancelling) throw new UpdateCancelled()
          set({ installation: review })
        },
      )
      // The release can disappear between the first check and the install click.
      if (!installed) {
        if (target === 'latest') set({ release: null, checked: true })
        else
          throw new Error(
            'The selected release is no longer available. / 所选版本已不可用，请刷新版本列表。',
          )
      }
    } catch (cause) {
      if (cause instanceof UpdateCancelled) set({ progress: null, error: null })
      else set({ error: reportFailure(cause) })
    } finally {
      usePresentationEditor.getState().unlockUpdate()
      set({ installing: false, targetRelease: null, installation: null, cancelling: false })
    }
  },

  cancelInstall: async () => {
    if (!get().installing || get().cancelling || get().progress?.phase === 'installing') return
    const generation = installationGeneration
    set({ cancelling: true })
    const review = get().installation
    if (!review) return
    try {
      const accepted = await cancelUpdate(review)
      if (generation === installationGeneration && get().installing && !accepted) {
        set({ cancelling: false })
      }
    } catch (cause) {
      if (generation === installationGeneration && get().installing) {
        set({ cancelling: false, error: reportFailure(cause) })
      }
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
  state.release !== null && state.release.version !== state.dismissed

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
  return readPreference(DISMISSED_KEY)
}

function writeDismissed(version: string): void {
  savePreference(DISMISSED_KEY, version)
}

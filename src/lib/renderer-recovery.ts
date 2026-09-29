import type { Presentation } from '@/state/presentation'
import { rendererReloading } from '@/lib/ipc'
import {
  canAutomaticallyReload,
  reloadPreservingPresentation,
} from '@/lib/presentation/renderer-recovery'
import { reportFailure } from '@/state/failure'

const PRELOAD_EVENT = 'vite:preloadError'
const PRELOAD_RELOAD_KEY = 'dsh-studio.renderer.preload-reload:v1'
const REARM_DEADLINE_MS = 500

/** Identity of this one loaded document, never persisted across a reload. */
export const rendererDocument = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

type RecoveryTarget = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>
  location: Pick<Location, 'reload'>
  setTimeout: (handler: () => void, timeout: number) => number
  clearTimeout: (timer: number) => void
}

type Rearm = () => Promise<void>

/**
 * Whether the local Workbench has to exist for the current desktop surface.
 *
 * A stopped Harness has no upstream page to display, so Compatibility and
 * Extended modes must fall back to the Workbench as well. `retained` keeps a
 * Workbench that was already opened mounted while the user briefly views the
 * upstream surface.
 */
export function needsWorkbench(
  harnessReady: boolean,
  presentation: Presentation,
  retained: boolean,
): boolean {
  return !harnessReady || presentation === 'advanced' || retained
}

/**
 * Recover once from a stale or unavailable Vite split chunk.
 *
 * Upgrading replaces hashed bundle filenames. WebView2 and WKWebView can keep
 * an older document alive long enough for one dynamic import to request a file
 * from the previous installation. Vite emits this event before rejecting that
 * import. Rearm the native watchdog, reload once, and then let the React error
 * boundary handle any repeat instead of creating a reload loop.
 */
export function installPreloadRecovery(
  target: RecoveryTarget = window,
  rearm: Rearm = async () => await rendererReloading(rendererDocument),
): () => void {
  const timers = new Set<number>()
  let disposed = false
  let cancel: (() => void) | null = null

  const onPreloadError = (event: Event) => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement)
      document.activeElement.blur()
    if (!canAutomaticallyReload()) return
    try {
      if (target.sessionStorage.getItem(PRELOAD_RELOAD_KEY) === '1') return
      // If this cannot be persisted, do not risk an endless reload. The lazy
      // rejection continues into the visible React recovery boundary instead.
      target.sessionStorage.setItem(PRELOAD_RELOAD_KEY, '1')
    } catch {
      return
    }

    // Acquire the clean-editor lock before rearming. Otherwise typing during
    // native IPC could cancel navigation but leave the watchdog armed.
    void reloadPreservingPresentation(
      () =>
        new Promise<void>((resolve, reject) => {
          event.preventDefault()
          let finished = false
          const clear = () => {
            for (const timer of timers) target.clearTimeout(timer)
            timers.clear()
            cancel = null
          }
          cancel = () => {
            finished = true
            clear()
            reject(new Error('Renderer recovery disposed'))
          }
          const reload = () => {
            if (finished || disposed) return
            finished = true
            clear()
            try {
              target.location.reload()
              resolve()
            } catch (cause) {
              reject(cause)
            }
          }
          const timer = target.setTimeout(reload, REARM_DEADLINE_MS)
          timers.add(timer)
          try {
            void rearm().then(reload, reload)
          } catch {
            // A detached test/preview can fail before returning a Promise.
            reload()
          }
        }),
      false,
    ).catch((cause) => {
      if (!disposed) reportFailure(cause)
    })
  }

  target.addEventListener(PRELOAD_EVENT, onPreloadError)
  return () => {
    disposed = true
    cancel?.()
    target.removeEventListener(PRELOAD_EVENT, onPreloadError)
    for (const timer of timers) target.clearTimeout(timer)
    timers.clear()
  }
}

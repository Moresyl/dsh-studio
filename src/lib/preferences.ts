import { preferenceSave } from '@/lib/ipc'
import { reportFailure } from '@/state/failure'

declare global {
  interface Window {
    /** Native bootstrap snapshot, available before state modules initialize. */
    readonly __DSH_SAVED_PREFERENCES__?: Record<string, string>
  }
}

let pending: Promise<void> = Promise.resolve()

export function readPreference(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key)
    if (value !== null) return value
  } catch {
    // A disabled Web storage implementation can still use the native snapshot.
  }
  return typeof window === 'undefined' ? null : (window.__DSH_SAVED_PREFERENCES__?.[key] ?? null)
}

/** Mirror for live cross-window reads, then serialize durable native writes. */
export function savePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Native persistence remains available even if Web storage is disabled.
  }
  const saved = window.__DSH_SAVED_PREFERENCES__
  if (!saved) return // Browser previews and unit fixtures have no native store.
  saved[key] = value
  pending = pending.catch(() => {}).then(() => preferenceSave(key, value))
  void pending.catch((cause: unknown) => reportFailure(cause))
}

/** Used by acceptance checks to distinguish scheduled and completed saves. */
export const flushPreferences = (): Promise<void> => pending

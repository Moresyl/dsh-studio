/**
 * Whether the harness is reachable from anywhere but this machine.
 *
 * Every mutation resolves with the status the Rust side ended up in, so the
 * store never has to model the door itself — it holds the last answer and asks
 * again when told something changed. A UI that guessed here could show a QR code
 * for a door that had already closed.
 */
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import type { RemoteStatus } from '@/lib/ipc'

interface RemoteStore {
  /** Null only until the first read lands. */
  status: RemoteStatus | null
  /** An open or close request is in flight. */
  busy: boolean
  error: string | null

  refresh: () => Promise<void>
  open: () => Promise<void>
  close: () => Promise<void>
}

export const useRemote = create<RemoteStore>((set, get) => ({
  status: null,
  busy: false,
  error: null,

  refresh: async () => {
    try {
      set({ status: await ipc.remoteStatus() })
    } catch (cause) {
      set({ error: describe(cause) })
    }
  },

  open: async () => {
    if (get().busy) return
    set({ busy: true, error: null })
    try {
      set({ status: await ipc.remoteOpen() })
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ busy: false })
    }
  },

  close: async () => {
    set({ busy: true, error: null })
    try {
      set({ status: await ipc.remoteClose() })
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ busy: false })
    }
  },
}))

/**
 * Follow connection changes for the lifetime of the app.
 *
 * Subscribed once from the window rather than from the panel, because the door
 * can also be closed by the supervisor — a harness that stops takes the remote
 * session with it, and the nav rail has to stop claiming otherwise even while
 * the user is looking at a different view.
 */
export const subscribeToRemote = (): Promise<() => void> =>
  ipc.onRemoteChange(() => void useRemote.getState().refresh())

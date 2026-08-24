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
import { reportFailure } from '@/state/failure'

interface RemoteStore {
  /** Null only until the first read lands. */
  status: RemoteStatus | null
  /** An open or close request is in flight. */
  busy: boolean
  error: string | null

  refresh: () => Promise<void>
  open: () => Promise<void>
  close: () => Promise<void>
  /** Put a new pairing code on screen after the last one ran out. */
  renew: () => Promise<void>
  /** Forget one paired device. */
  forget: (id: string) => Promise<void>
}

/** A mutation invalidates older reads; overlapping reads keep only the newest. */
let mutationGeneration = 0
let refreshGeneration = 0

export const useRemote = create<RemoteStore>((set, get) => ({
  status: null,
  busy: false,
  error: null,

  refresh: async () => {
    const mine = ++refreshGeneration
    const mutations = mutationGeneration
    try {
      const status = await ipc.remoteStatus()
      if (mine === refreshGeneration && mutations === mutationGeneration) {
        set({ status, error: null })
      }
    } catch (cause) {
      if (mine === refreshGeneration && mutations === mutationGeneration) {
        set({ error: describe(cause) })
      }
    }
  },

  open: async () => {
    if (get().busy) return
    const mine = ++mutationGeneration
    set({ busy: true, error: null })
    try {
      const status = await ipc.remoteOpen()
      if (mine === mutationGeneration) set({ status, error: null })
    } catch (cause) {
      if (mine === mutationGeneration) set({ error: reportFailure(cause) })
    } finally {
      set({ busy: false })
    }
  },

  close: async () => {
    if (get().busy) return
    const mine = ++mutationGeneration
    set({ busy: true, error: null })
    try {
      const status = await ipc.remoteClose()
      if (mine === mutationGeneration) set({ status, error: null })
    } catch (cause) {
      if (mine === mutationGeneration) set({ error: reportFailure(cause) })
    } finally {
      set({ busy: false })
    }
  },

  // Neither of these takes `busy`: it drives the open/close button, and a
  // disabled Close while a code is being replaced would be a lie about which
  // request is in flight.
  renew: async () => {
    const mine = ++mutationGeneration
    set({ error: null })
    try {
      const status = await ipc.remoteRenew()
      if (mine === mutationGeneration) set({ status, error: null })
    } catch (cause) {
      if (mine === mutationGeneration) set({ error: reportFailure(cause) })
    }
  },

  forget: async (id) => {
    const mine = ++mutationGeneration
    set({ error: null })
    try {
      const status = await ipc.remoteForget(id)
      if (mine === mutationGeneration) set({ status, error: null })
    } catch (cause) {
      if (mine === mutationGeneration) set({ error: reportFailure(cause) })
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

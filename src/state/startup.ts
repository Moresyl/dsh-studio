/**
 * How this machine reaches the app while its window is not in front.
 *
 * Rust answers every change with the whole picture rather than an
 * acknowledgement, so this store holds the last answer and never computes a new
 * one. That matters more here than elsewhere: a login item can be taken away
 * from Task Manager and a hotkey can be lost to another program, and a switch
 * that showed what was asked for instead of what happened would be wrong for as
 * long as the pane stayed open.
 */
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import type { Startup } from '@/lib/ipc'
import type { NotificationPreference } from '@/lib/ipc'
import type { LogLevel } from '@/lib/ipc'
import { reportFailure } from '@/state/failure'

interface StartupStore {
  /** Null until the first read lands. */
  state: Startup | null
  /** A change is in flight, and the switches wait for it. */
  busy: boolean
  error: string | null

  refresh: () => Promise<void>
  setAutostart: (enabled: boolean) => Promise<void>
  /** `null` gives the key up. */
  setShortcut: (accelerator: string | null) => Promise<void>
  setNotification: (kind: NotificationPreference, enabled: boolean) => Promise<void>
  testNotification: () => Promise<void>
  setLogLevel: (level: LogLevel) => Promise<void>
  setHarnessPort: (port: number | null) => Promise<void>
  /** Take the same key again after another program has let go of it. */
  retry: () => Promise<void>
}

/** A settings write makes every older settings read stale. */
let mutationGeneration = 0
let refreshGeneration = 0

export const useStartup = create<StartupStore>((set, get) => ({
  state: null,
  busy: false,
  error: null,

  refresh: async () => {
    if (get().busy) return
    const mine = ++refreshGeneration
    const mutations = mutationGeneration
    try {
      const state = await ipc.startupState()
      if (mine === refreshGeneration && mutations === mutationGeneration) {
        set({ state, error: null })
      }
    } catch (cause) {
      if (mine === refreshGeneration && mutations === mutationGeneration) {
        set({ error: describe(cause) })
      }
    }
  },

  setAutostart: async (enabled) => {
    await change(set, get, () => ipc.startupAutostart(enabled))
  },

  setShortcut: async (accelerator) => {
    await change(set, get, () => ipc.startupShortcut(accelerator))
  },

  setNotification: async (kind, enabled) => {
    await change(set, get, () => ipc.startupNotification(kind, enabled))
  },

  testNotification: async () => {
    await change(set, get, () => ipc.startupNotificationTest())
  },

  setLogLevel: async (level) => {
    await change(set, get, () => ipc.startupLogLevel(level))
  },

  setHarnessPort: async (port) => {
    await change(set, get, () => ipc.startupHarnessPort(port))
  },

  retry: async () => {
    const wanted = get().state?.shortcut
    if (!wanted) return
    await change(set, get, () => ipc.startupShortcut(wanted))
  },
}))

type Set = (partial: Partial<StartupStore>) => void
type Get = () => StartupStore

/**
 * One change at a time, and the error kept until the next one is attempted.
 *
 * Refusals are the ordinary case here rather than the exception — a combination
 * another program is holding is a normal thing to try — so the message stays on
 * screen next to the control that produced it and is also placed in the global,
 * copyable failure dialog.
 */
async function change(set: Set, get: Get, run: () => Promise<Startup>): Promise<void> {
  if (get().busy) return
  mutationGeneration += 1
  set({ busy: true, error: null })
  try {
    set({ state: await run() })
  } catch (cause) {
    set({ error: reportFailure(cause) })
  } finally {
    set({ busy: false })
  }
}

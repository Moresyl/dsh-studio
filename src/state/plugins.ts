/**
 * The marketplace: what the registry has, and what the profile has.
 *
 * Two halves that never write to each other. Search results come from the
 * network and are allowed to be stale; the installed list only ever comes back
 * from a completed change, so the panel cannot draw a plugin as installed
 * because a click looked like it worked.
 *
 * Searches carry a generation number because typing produces overlapping
 * requests, and the one that answers last is not the one that was asked last.
 */
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import type { InstalledPlugin, PluginDetail, PluginListing, PluginState } from '@/lib/ipc'

interface PluginStore {
  /** The hosted profile as it is on disk. Null until the first read lands. */
  profile: PluginState | null
  results: PluginListing[]
  /** The package the detail rail is describing, if any. */
  selected: string | null
  detail: PluginDetail | null

  searching: boolean
  loadingDetail: boolean
  /** The package name a change is running against, or null when idle. */
  working: string | null
  error: string | null

  refresh: () => Promise<void>
  search: (query: string) => Promise<void>
  select: (name: string | null) => Promise<void>
  add: (spec: string) => Promise<void>
  remove: (name: string) => Promise<void>
  /** Take an installed plugin out of the layer stack, or put it back. */
  toggle: (name: string, enabled: boolean) => Promise<void>
}

/** Only the newest search may write results; older answers are dropped. */
let generation = 0

export const usePlugins = create<PluginStore>((set, get) => ({
  profile: null,
  results: [],
  selected: null,
  detail: null,
  searching: false,
  loadingDetail: false,
  working: null,
  error: null,

  refresh: async () => {
    try {
      set({ profile: await ipc.pluginState() })
    } catch (cause) {
      set({ error: describe(cause) })
    }
  },

  search: async (query) => {
    const mine = ++generation
    set({ searching: true, error: null })
    try {
      const results = await ipc.pluginSearch(query)
      if (mine === generation) set({ results })
    } catch (cause) {
      if (mine === generation) set({ error: describe(cause), results: [] })
    } finally {
      if (mine === generation) set({ searching: false })
    }
  },

  select: async (name) => {
    if (name === null) {
      set({ selected: null, detail: null })
      return
    }

    set({ selected: name, detail: null, loadingDetail: true })
    try {
      const detail = await ipc.pluginDetail(name)
      // Still the selection this request was made for, or it belongs to a
      // package the user has already clicked away from.
      if (get().selected === name) set({ detail })
    } catch (cause) {
      if (get().selected === name) set({ error: describe(cause) })
    } finally {
      if (get().selected === name) set({ loadingDetail: false })
    }
  },

  add: async (spec) => {
    if (get().working) return
    set({ working: spec, error: null })
    try {
      set({ profile: await ipc.pluginAdd(spec) })
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ working: null })
    }
  },

  remove: async (name) => {
    if (get().working) return
    set({ working: name, error: null })
    try {
      set({ profile: await ipc.pluginRemove(name) })
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ working: null })
    }
  },

  toggle: async (name, enabled) => {
    // Shares `working` with the two slow changes, because all three write to
    // the same profile manifest and the harness reconciles it after each one.
    // Fast enough that the flicker is the point: it says the write landed.
    if (get().working) return
    set({ working: name, error: null })
    try {
      set({ profile: await ipc.pluginSwitch(name, enabled) })
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ working: null })
    }
  },
}))

/** The profile's entry for `name`, or null when it is not installed. */
export const installedPlugin = (
  profile: PluginState | null,
  name: string | null,
): InstalledPlugin | null =>
  (name !== null && profile?.plugins.find((plugin) => plugin.name === name)) || null

/** Whether `name` is already in the profile, under any version range. */
export const isInstalled = (profile: PluginState | null, name: string): boolean =>
  profile?.plugins.some((plugin) => plugin.name === name) ?? false

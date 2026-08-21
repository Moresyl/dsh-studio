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
import type {
  ArchivePackage,
  CatalogSource,
  InstalledPlugin,
  PluginDetail,
  PluginListing,
  PluginSort,
  PluginState,
} from '@/lib/ipc'

interface PluginStore {
  /** The hosted profile as it is on disk. Null until the first read lands. */
  profile: PluginState | null
  results: PluginListing[]
  categories: string[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  indexedAt: number
  sources: CatalogSource[]
  /** The package the detail rail is describing, if any. */
  selected: string | null
  selectedSource: string | null
  selectedVersion: string | null
  detail: PluginDetail | null

  searching: boolean
  loadingDetail: boolean
  /** The package name a change is running against, or null when idle. */
  working: string | null
  error: string | null

  refresh: () => Promise<void>
  search: (
    query: string,
    category: string | null,
    sort: PluginSort,
    page: number,
    refresh?: boolean,
  ) => Promise<void>
  select: (name: string | null, sourceId?: string, version?: string) => Promise<void>
  selectSource: (id: string) => Promise<void>
  addSource: (label: string, endpoint: string) => Promise<boolean>
  removeSource: (id: string) => Promise<void>
  add: (spec: string) => Promise<void>
  remove: (name: string) => Promise<void>
  /** Take an installed plugin out of the layer stack, or put it back. */
  toggle: (name: string, enabled: boolean) => Promise<void>
  /** Read a picked archive, so its package can be named before it is installed. */
  inspect: (path: string) => Promise<ArchivePackage | null>
  /** Install from an archive already read by `inspect`. */
  bringIn: (archive: ArchivePackage) => Promise<void>
}

/** Only the newest search may write results; older answers are dropped. */
let generation = 0

type Write = (partial: Partial<PluginStore>) => void

/**
 * A change to the hosted profile landed.
 *
 * All three changes end the same way — the reply is the profile as it now is,
 * and the profile is a directory the other windows are reading too. The roster
 * behind the title bar chip counts what is installed in each one, so this is
 * not only for another window with this panel open.
 */
const landed = (set: Write, profile: PluginState): void => {
  set({ profile })
  void ipc.announce('profiles')
}

export const usePlugins = create<PluginStore>((set, get) => ({
  profile: null,
  results: [],
  categories: [],
  total: 0,
  page: 0,
  pageSize: 25,
  hasMore: false,
  indexedAt: 0,
  sources: [],
  selected: null,
  selectedSource: null,
  selectedVersion: null,
  detail: null,
  searching: false,
  loadingDetail: false,
  working: null,
  error: null,

  refresh: async () => {
    try {
      const [profile, sources] = await Promise.all([ipc.pluginState(), ipc.pluginSources()])
      set({ profile, sources })
    } catch (cause) {
      set({ error: describe(cause) })
    }
  },

  search: async (query, category, sort, page, refresh = false) => {
    const mine = ++generation
    set({ searching: true, error: null })
    try {
      const answer = await ipc.pluginSearch(query, category, sort, page, refresh)
      if (mine === generation) {
        set({
          results: answer.items,
          categories: answer.categories,
          total: answer.total,
          page: answer.page,
          pageSize: answer.pageSize,
          hasMore: answer.hasMore,
          indexedAt: answer.indexedAt,
        })
      }
    } catch (cause) {
      if (mine === generation) {
        set({ error: describe(cause), results: [], total: 0, hasMore: false })
      }
    } finally {
      if (mine === generation) set({ searching: false })
    }
  },

  select: async (name, sourceId = 'npm', version = 'latest') => {
    if (name === null) {
      set({ selected: null, selectedSource: null, selectedVersion: null, detail: null })
      return
    }

    set({
      selected: name,
      selectedSource: sourceId,
      selectedVersion: version,
      detail: null,
      loadingDetail: true,
    })
    try {
      const detail = await ipc.pluginDetail(sourceId, name, version)
      // Still the selection this request was made for, or it belongs to a
      // package the user has already clicked away from.
      const current = get()
      if (
        current.selected === name &&
        current.selectedSource === sourceId &&
        current.selectedVersion === version
      ) {
        set({ detail })
      }
    } catch (cause) {
      const current = get()
      if (
        current.selected === name &&
        current.selectedSource === sourceId &&
        current.selectedVersion === version
      ) {
        set({ error: describe(cause) })
      }
    } finally {
      if (get().selected === name) set({ loadingDetail: false })
    }
  },

  selectSource: async (id) => {
    try {
      const sources = await ipc.pluginSourceSelect(id)
      set({
        sources,
        results: [],
        categories: [],
        total: 0,
        page: 0,
        hasMore: false,
        selected: null,
        selectedSource: null,
        selectedVersion: null,
        detail: null,
        error: null,
      })
    } catch (cause) {
      set({ error: describe(cause) })
    }
  },

  addSource: async (label, endpoint) => {
    try {
      const sources = await ipc.pluginSourceAdd(label, endpoint)
      set({ sources, results: [], categories: [], total: 0, page: 0, error: null })
      return true
    } catch (cause) {
      set({ error: describe(cause) })
      return false
    }
  },

  removeSource: async (id) => {
    try {
      const sources = await ipc.pluginSourceRemove(id)
      set({
        sources,
        results: [],
        categories: [],
        total: 0,
        page: 0,
        selected: null,
        detail: null,
        error: null,
      })
    } catch (cause) {
      set({ error: describe(cause) })
    }
  },

  add: async (spec) => {
    if (get().working) return
    const selected = get().selected
    const sourceId = get().selectedSource
    if (!selected || !sourceId) {
      set({ error: 'The selected market item no longer exists.' })
      return
    }
    set({ working: packageName(spec), error: null })
    try {
      landed(set, await ipc.pluginAdd(spec, sourceId, selected, get().detail?.name ?? selected))
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
      landed(set, await ipc.pluginRemove(name))
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
      landed(set, await ipc.pluginSwitch(name, enabled))
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ working: null })
    }
  },

  inspect: async (path) => {
    set({ error: null })
    try {
      return await ipc.pluginArchive(path)
    } catch (cause) {
      // The usual answer here is that the file is not a package at all, and the
      // sentence Rust wrote about it says which file and why.
      set({ error: describe(cause) })
      return null
    }
  },

  bringIn: async (archive) => {
    if (get().working) return
    // Named by the package rather than by the file: the progress line under the
    // list is about what is being installed, not about where it was found.
    set({ working: archive.name, error: null })
    try {
      landed(set, await ipc.pluginImport(archive.path))
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

/** Package name without an exact version used to make installation immutable. */
export const packageName = (spec: string): string => {
  const offset = spec.startsWith('@') ? 1 : 0
  const separator = spec.indexOf('@', offset)
  return separator < 0 ? spec : spec.slice(0, separator)
}

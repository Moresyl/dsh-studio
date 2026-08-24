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
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { showError } from '@/state/dialog'
import type {
  ArchivePackage,
  CatalogHealth,
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
  sourceHealth: Record<string, CatalogHealth>
  /** The package the detail rail is describing, if any. */
  selected: string | null
  selectedSource: string | null
  selectedVersion: string | null
  detail: PluginDetail | null

  searching: boolean
  loadingDetail: boolean
  previewing: boolean
  previewToken: string | null
  /** Native expiry for the one-shot confirmation, expressed in wall-clock ms. */
  previewExpiresAt: number | null
  /** A catalog-source choice or edit is being committed. */
  sourceWorking: boolean
  checkingSource: string | null
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
  /** Open an installed package without asking a registry that may never have seen it. */
  selectInstalled: (plugin: InstalledPlugin) => void
  selectSource: (id: string) => Promise<void>
  addSource: (label: string, endpoint: string) => Promise<boolean>
  removeSource: (id: string) => Promise<void>
  checkSource: (id: string) => Promise<void>
  preview: (spec: string) => Promise<boolean>
  add: () => Promise<boolean>
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
/** Invalidates an install preview when its catalog selection changes. */
let previewGeneration = 0
/** A source or profile mutation makes an older combined refresh stale. */
let stateGeneration = 0

type Write = (partial: Partial<PluginStore>) => void

/** Keep the inline history while also making failures impossible to miss. */
const failed = (set: Write, cause: unknown): void => {
  const error = typeof cause === 'string' ? cause : describe(cause)
  set({ error })
  showError({
    title: t('plugins.error.title'),
    body: t('plugins.error.body'),
    details: error,
    close: t('dialog.error.close'),
    copy: t('dialog.error.copy'),
    copied: t('dialog.error.copied'),
  })
}

/** Whether a detail answer still belongs to the item the rail is showing. */
const isSelected = (state: PluginStore, name: string, sourceId: string, version: string): boolean =>
  state.selected === name && state.selectedSource === sourceId && state.selectedVersion === version

/**
 * A change to the hosted profile landed.
 *
 * All three changes end the same way — the reply is the profile as it now is,
 * and the profile is a directory the other windows are reading too. The roster
 * behind the title bar chip counts what is installed in each one, so this is
 * not only for another window with this panel open.
 */
const landed = (set: Write, profile: PluginState): void => {
  ++stateGeneration
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
  sourceHealth: {},
  selected: null,
  selectedSource: null,
  selectedVersion: null,
  detail: null,
  searching: false,
  loadingDetail: false,
  previewing: false,
  previewToken: null,
  previewExpiresAt: null,
  sourceWorking: false,
  checkingSource: null,
  working: null,
  error: null,

  refresh: async () => {
    if (get().working || get().sourceWorking) return
    const mine = ++stateGeneration
    try {
      const [profile, sources] = await Promise.all([ipc.pluginState(), ipc.pluginSources()])
      if (mine === stateGeneration) set({ profile, sources, error: null })
    } catch (cause) {
      if (mine === stateGeneration) failed(set, cause)
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
        failed(set, cause)
        set({ results: [], total: 0, hasMore: false })
      }
    } finally {
      if (mine === generation) set({ searching: false })
    }
  },

  select: async (name, sourceId = 'npm', version = 'latest') => {
    ++previewGeneration
    if (name === null) {
      set({
        selected: null,
        selectedSource: null,
        selectedVersion: null,
        detail: null,
        previewing: false,
        previewToken: null,
        previewExpiresAt: null,
      })
      return
    }

    set({
      selected: name,
      selectedSource: sourceId,
      selectedVersion: version,
      detail: null,
      loadingDetail: true,
      previewing: false,
      previewToken: null,
      previewExpiresAt: null,
    })
    try {
      const detail = await ipc.pluginDetail(sourceId, name, version)
      // Still the selection this request was made for, or it belongs to a
      // package the user has already clicked away from.
      if (isSelected(get(), name, sourceId, version)) set({ detail })
    } catch (cause) {
      if (isSelected(get(), name, sourceId, version)) {
        failed(set, cause)
      }
    } finally {
      if (isSelected(get(), name, sourceId, version)) set({ loadingDetail: false })
    }
  },

  selectInstalled: (plugin) => {
    ++previewGeneration
    const version = plugin.spec || 'bundled'
    set({
      selected: plugin.name,
      selectedSource: 'profile',
      selectedVersion: version,
      detail: {
        name: plugin.name,
        version,
        description: '',
        license: '',
        homepage: null,
        repository: null,
        bundle: plugin.active || plugin.disabled || plugin.builtin,
        dependencies: [],
        installSpec: plugin.name,
        source: plugin.spec || 'profile bundle',
        compatibility: { state: 'unknown' },
        integrity: null,
        bundlePatch: null,
        lifecycleScripts: [],
        deprecated: null,
        repositoryVerified: false,
        integrityVerified: false,
      },
      loadingDetail: false,
      previewing: false,
      previewToken: null,
      previewExpiresAt: null,
      error: null,
    })
  },

  selectSource: async (id) => {
    if (get().working || get().sourceWorking) return
    ++previewGeneration
    ++stateGeneration
    set({
      sourceWorking: true,
      previewing: false,
      previewToken: null,
      previewExpiresAt: null,
      error: null,
    })
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
        previewToken: null,
        previewExpiresAt: null,
        error: null,
      })
    } catch (cause) {
      failed(set, cause)
    } finally {
      set({ sourceWorking: false })
    }
  },

  addSource: async (label, endpoint) => {
    if (get().working || get().sourceWorking) return false
    ++previewGeneration
    ++stateGeneration
    set({
      sourceWorking: true,
      previewing: false,
      previewToken: null,
      previewExpiresAt: null,
      error: null,
    })
    try {
      const sources = await ipc.pluginSourceAdd(label, endpoint)
      set({
        sources,
        results: [],
        categories: [],
        total: 0,
        page: 0,
        selected: null,
        detail: null,
        previewToken: null,
        previewExpiresAt: null,
        error: null,
      })
      return true
    } catch (cause) {
      failed(set, cause)
      return false
    } finally {
      set({ sourceWorking: false })
    }
  },

  removeSource: async (id) => {
    if (get().working || get().sourceWorking) return
    ++previewGeneration
    ++stateGeneration
    set({
      sourceWorking: true,
      previewing: false,
      previewToken: null,
      previewExpiresAt: null,
      error: null,
    })
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
        previewToken: null,
        previewExpiresAt: null,
        error: null,
      })
    } catch (cause) {
      failed(set, cause)
    } finally {
      set({ sourceWorking: false })
    }
  },

  checkSource: async (id) => {
    if (get().checkingSource) return
    set({ checkingSource: id, error: null })
    try {
      const health = await ipc.pluginSourceHealth(id)
      set((state) => ({ sourceHealth: { ...state.sourceHealth, [id]: health } }))
    } catch (cause) {
      failed(set, cause)
    } finally {
      set({ checkingSource: null })
    }
  },

  preview: async (spec) => {
    if (get().working || get().previewing) return false
    const selected = get().selected
    const sourceId = get().selectedSource
    const version = get().selectedVersion
    if (!selected || !sourceId) {
      failed(set, 'The selected market item no longer exists.')
      return false
    }
    const mine = ++previewGeneration
    set({ previewing: true, previewToken: null, previewExpiresAt: null, error: null })
    try {
      const preview = await ipc.pluginPreview(
        spec,
        sourceId,
        selected,
        get().detail?.name ?? selected,
      )
      if (
        mine === previewGeneration &&
        isSelected(get(), selected, sourceId, version ?? 'latest')
      ) {
        set({
          previewToken: preview.token,
          previewExpiresAt: Date.now() + preview.expiresInSeconds * 1_000,
        })
        return true
      }
      return false
    } catch (cause) {
      if (mine === previewGeneration) failed(set, cause)
      return false
    } finally {
      if (mine === previewGeneration) set({ previewing: false })
    }
  },

  add: async () => {
    if (get().working || get().previewing) return false
    let token = get().previewToken
    const expiresAt = get().previewExpiresAt

    // The confirmation screen may reasonably stay open while somebody reads
    // the manifest. If its native one-shot token expired meanwhile, verify the
    // same exact package again at the confirming click instead of presenting an
    // Install button that can only fail. The backend still binds the fresh
    // token to this source, package, version and active profile.
    if (!token || expiresAt === null || expiresAt <= Date.now()) {
      const spec = get().detail?.installSpec
      if (!spec || !(await get().preview(spec))) return false
      token = get().previewToken
      if (!token) return false
    }
    const selected = get().selected ?? 'plugin'
    ++stateGeneration
    set({
      working: packageName(selected),
      previewToken: null,
      previewExpiresAt: null,
      error: null,
    })
    try {
      landed(set, await ipc.pluginAdd(token))
      return true
    } catch (cause) {
      failed(set, cause)
      return false
    } finally {
      set({ working: null })
    }
  },

  remove: async (name) => {
    if (get().working) return
    ++stateGeneration
    set({ working: name, error: null })
    try {
      landed(set, await ipc.pluginRemove(name))
    } catch (cause) {
      failed(set, cause)
    } finally {
      set({ working: null })
    }
  },

  toggle: async (name, enabled) => {
    // Shares `working` with the two slow changes, because all three write to
    // the same profile manifest and the harness reconciles it after each one.
    // Fast enough that the flicker is the point: it says the write landed.
    if (get().working) return
    ++stateGeneration
    set({ working: name, error: null })
    try {
      landed(set, await ipc.pluginSwitch(name, enabled))
    } catch (cause) {
      failed(set, cause)
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
      failed(set, cause)
      return null
    }
  },

  bringIn: async (archive) => {
    if (get().working) return
    // Named by the package rather than by the file: the progress line under the
    // list is about what is being installed, not about where it was found.
    ++stateGeneration
    set({ working: archive.name, error: null })
    try {
      landed(set, await ipc.pluginImport(archive.path))
    } catch (cause) {
      failed(set, cause)
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

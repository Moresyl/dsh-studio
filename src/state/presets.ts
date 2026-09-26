/**
 * Which agent the harness starts new sessions as.
 *
 * A store rather than component state because the choice is offered in two
 * places — once in the guide and permanently on the console — and two copies of
 * the same radio group would drift the moment either one was used.
 *
 * The chosen id moves before the write comes back. That is not optimism about
 * whether the write will succeed; it is that this is a radio button, and a radio
 * button that waits for a file to be written before it looks selected reads as
 * broken. A failure puts it back and says so.
 */
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import { t } from '@/lib/i18n'
import type { AgentPreset } from '@/lib/ipc'
import { ask } from '@/state/dialog'

interface PresetStore {
  /** In the order the harness lists them; empty until it is installed. */
  presets: AgentPreset[]
  chosen: string | null
  /** True until the first read comes back, so nothing renders an empty list. */
  loading: boolean
  error: string | null

  refresh: () => Promise<void>
  choose: (id: string) => Promise<void>
}

/** Only the newest roster read or choice may update the radio group. */
let generation = 0
let activeImport: { path: string; operation: Promise<boolean> } | null = null

export const isPresetPackagePath = (path: string): boolean => /\.dshpreset$/i.test(path)

export const usePresets = create<PresetStore>((set, get) => ({
  presets: [],
  chosen: null,
  loading: true,
  error: null,

  refresh: async () => {
    const mine = ++generation
    try {
      const roster = await ipc.presetRoster()
      if (mine === generation) {
        set({ presets: roster.presets, chosen: roster.default, error: null })
      }
    } catch (cause) {
      if (mine === generation) set({ error: describe(cause) })
    } finally {
      if (mine === generation) set({ loading: false })
    }
  },

  choose: async (id) => {
    const previous = get().chosen
    if (id === previous) return
    const mine = ++generation
    set({ chosen: id, error: null })

    try {
      // The reply is the roster as it is now, so the list and the selection come
      // back from the file rather than from what was asked for.
      const roster = await ipc.presetChoose(id)
      if (mine === generation) set({ presets: roster.presets, chosen: roster.default })
    } catch (cause) {
      if (mine === generation) {
        set({ chosen: previous, error: t('preset.failed', { reason: describe(cause) }) })
      }
    }
  },
}))

/**
 * Inspect and explicitly confirm a portable preset before publishing it.
 *
 * Both the native file association and the in-app picker use this path. Joining
 * duplicate requests matters on macOS, where a startup file URL can be visible
 * both as an initial offer and as a live open event during renderer startup.
 */
export function importPresetPackage(path: string): Promise<boolean> {
  if (activeImport?.path === path) return activeImport.operation
  if (activeImport) return Promise.reject(new Error(t('preset.importBusy')))

  const operation = (async () => {
    const preview = await ipc.presetPackage(path)
    if (!preview.integrityVerified) throw new Error(t('preset.integrityFailed'))
    const accepted = await ask({
      title: t('preset.importConfirmTitle'),
      body: t('preset.importConfirmBody', {
        files: preview.files,
        bytes: preview.bytes.toLocaleString(),
      }),
      subject: preview.name ? `${preview.name} (${preview.id})` : preview.id,
      confirm: t('preset.importConfirm'),
      tone: 'brand',
    })
    if (!accepted) return false

    const roster = await ipc.presetImport(path)
    ++generation
    usePresets.setState({
      presets: roster.presets,
      chosen: roster.default,
      loading: false,
      error: null,
    })
    return true
  })().finally(() => {
    if (activeImport?.operation === operation) activeImport = null
  })
  activeImport = { path, operation }
  return operation
}

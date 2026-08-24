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

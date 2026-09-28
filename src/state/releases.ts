import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import { discardReview, reviewVersion, type Release } from '@/lib/updater'

let pageGeneration = 0
let reviewGeneration = 0

interface ReleaseHistoryState {
  entries: ipc.ApplicationReleaseSummary[]
  page: number
  hasMore: boolean
  loading: boolean
  error: string | null
  selected: string | null
  review: Release | null
  reviewing: boolean
  reviewError: string | null
  load: (page?: number) => Promise<void>
  select: (version: string) => Promise<void>
  dispose: () => void
}

const empty = {
  entries: [] as ipc.ApplicationReleaseSummary[],
  page: 1,
  hasMore: false,
  loading: false,
  error: null,
  selected: null,
  review: null,
  reviewing: false,
  reviewError: null,
}

export const useReleaseHistory = create<ReleaseHistoryState>((set, get) => ({
  ...empty,
  load: async (page = 1) => {
    const generation = ++pageGeneration
    ++reviewGeneration
    void discardReview(get().review)
    set({
      loading: true,
      error: null,
      selected: null,
      review: null,
      reviewing: false,
      reviewError: null,
    })
    try {
      const result = await ipc.applicationVersions(page)
      if (generation !== pageGeneration) return
      set({ entries: result.releases, page: result.page, hasMore: result.hasMore, loading: false })
      if (result.releases[0]) await get().select(result.releases[0].version)
    } catch (cause) {
      if (generation === pageGeneration) set({ loading: false, error: describe(cause) })
    }
  },

  select: async (version) => {
    const entry = get().entries.find((entry) => entry.version === version)
    if (!entry || get().loading) return
    const generation = ++reviewGeneration
    void discardReview(get().review)
    set({ selected: version, review: null, reviewError: null, reviewing: entry.hasUpdater })
    if (!entry.hasUpdater) return
    try {
      const review = await reviewVersion(version)
      if (generation !== reviewGeneration) {
        void discardReview(review)
        return
      }
      set({ review, reviewing: false })
    } catch (cause) {
      if (generation === reviewGeneration) set({ reviewing: false, reviewError: describe(cause) })
    }
  },

  dispose: () => {
    ++pageGeneration
    ++reviewGeneration
    void discardReview(get().review)
    set(empty)
  },
}))

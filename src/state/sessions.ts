/**
 * Every conversation the harness has had on this machine.
 *
 * Three things that are read and never written: the list, a search over it, and
 * one session opened in full. Nothing here can change a session, because nothing
 * should — the harness is appending to those files while this pane is open.
 *
 * Searches carry a generation number for the usual reason: typing produces
 * overlapping requests, and the one that answers last is not the one that was
 * asked last. The first search of a run is the slow one, since it is also the
 * first read of every log on the disk, so answers arriving out of order is the
 * normal case here rather than the rare one.
 */
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import type { SessionCard, SessionHit, SessionTranscript } from '@/lib/ipc'

interface SessionStore {
  /** Every session, newest first. Null until the first read lands. */
  cards: SessionCard[] | null
  /** What the last search found, or null when nothing is being searched for. */
  hits: SessionHit[] | null
  query: string
  /** Narrow to one project directory, or null for all of them. */
  project: string | null

  /** The session being read, and its id while it is still being fetched. */
  opened: SessionTranscript | null
  opening: string | null

  scanning: boolean
  searching: boolean
  error: string | null

  refresh: () => Promise<void>
  search: (query: string) => Promise<void>
  /** Look again with the same words, after narrowing to a project or widening. */
  narrow: (project: string | null) => Promise<void>
  open: (id: string) => Promise<void>
  close: () => void
}

/** Only the newest search may write results; older answers are dropped. */
let generation = 0

export const useSessions = create<SessionStore>((set, get) => ({
  cards: null,
  hits: null,
  query: '',
  project: null,
  opened: null,
  opening: null,
  scanning: false,
  searching: false,
  error: null,

  refresh: async () => {
    set({ scanning: true, error: null })
    try {
      const { cards } = await ipc.sessionRoster()
      set({ cards })
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ scanning: false })
    }
  },

  search: async (query) => {
    const mine = ++generation
    set({ query })

    // An empty box is not a search that found nothing, it is no search — and the
    // list underneath it is the answer.
    if (!query.trim()) {
      set({ hits: null, searching: false, error: null })
      return
    }

    set({ searching: true, error: null })
    try {
      const hits = await ipc.sessionSearch(query, get().project ?? undefined)
      if (mine === generation) set({ hits })
    } catch (cause) {
      if (mine === generation) set({ error: describe(cause), hits: [] })
    } finally {
      if (mine === generation) set({ searching: false })
    }
  },

  narrow: async (project) => {
    set({ project })
    await get().search(get().query)
  },

  open: async (id) => {
    set({ opening: id, opened: null, error: null })
    try {
      const opened = await ipc.sessionRead(id)
      // Still the session this was asked for, or the user has moved on.
      if (get().opening === id) set({ opened })
    } catch (cause) {
      if (get().opening === id) set({ error: describe(cause) })
    } finally {
      if (get().opening === id) set({ opening: null })
    }
  },

  close: () => set({ opened: null, opening: null }),
}))

/** Every project a session has run in, most recently used first. */
export function projects(cards: SessionCard[]): string[] {
  const seen: string[] = []

  for (const card of cards) {
    if (!card.project || seen.includes(card.project)) continue
    seen.push(card.project)
  }

  return seen
}

/** What a whole shelf of sessions cost, added up. */
export function spent(cards: SessionCard[]): ipc.Tokens {
  return cards.reduce<ipc.Tokens>(
    (total, card) => ({
      input: total.input + card.tokens.input,
      output: total.output + card.tokens.output,
      cacheRead: total.cacheRead + card.tokens.cacheRead,
      cacheWrite: total.cacheWrite + card.tokens.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )
}

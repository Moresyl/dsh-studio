/**
 * Every conversation the harness has had on this machine.
 *
 * Three things that are read: the list, a search over it, and one session opened
 * in full. Nothing here can change a session, because nothing should — the
 * harness is appending to those files while this pane is open. The one thing
 * that writes writes somewhere else entirely: an export is a new file at a path
 * the user just pointed at, and the session it was made from is untouched.
 *
 * Searches carry a generation number for the usual reason: typing produces
 * overlapping requests, and the one that answers last is not the one that was
 * asked last. The first search of a run is the slow one, since it is also the
 * first read of every log on the disk, so answers arriving out of order is the
 * normal case here rather than the rare one.
 */
import { save as pickPath } from '@tauri-apps/plugin-dialog'
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import type { SessionCard, SessionHit, SessionTranscript } from '@/lib/ipc'
import { reportFailure } from '@/state/failure'

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
  /** True while a session is being rendered out, which on a long one is not instant. */
  exporting: boolean
  error: string | null

  refresh: () => Promise<void>
  search: (query: string) => Promise<void>
  /** Look again with the same words, after narrowing to a project or widening. */
  narrow: (project: string | null) => Promise<void>
  open: (id: string) => Promise<void>
  close: () => void

  /**
   * Render a session and put it on the clipboard.
   *
   * Answers whether it got there, so the control that asked can confirm it
   * rather than leaving a keystroke that appears to have done nothing.
   */
  copyOut: (id: string, format: ipc.SessionFormat) => Promise<boolean>

  /**
   * Render a session, ask where it goes, and write it there.
   *
   * `kind` is what the save dialog should call this sort of file in its filter,
   * which is a phrase in the user's language and so belongs to the view. False
   * covers both a failure and a dismissed dialog, because neither one wrote a
   * file and only one of them has anything to say about it.
   */
  saveOut: (id: string, format: ipc.SessionFormat, kind: string) => Promise<boolean>
}

type Write = (partial: Partial<SessionStore>) => void

/** Only the newest search may write results; older answers are dropped. */
let generation = 0

/** Opening the same id twice still produces two snapshots; only the last wins. */
let openingGeneration = 0

export const useSessions = create<SessionStore>((set, get) => ({
  cards: null,
  hits: null,
  query: '',
  project: null,
  opened: null,
  opening: null,
  scanning: false,
  searching: false,
  exporting: false,
  error: null,

  refresh: async () => {
    if (get().scanning) return
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
    const mine = ++openingGeneration
    set({ opening: id, opened: null, error: null })
    try {
      const opened = await ipc.sessionRead(id)
      // Still the session this was asked for, or the user has moved on.
      if (mine === openingGeneration && get().opening === id) set({ opened })
    } catch (cause) {
      if (mine === openingGeneration && get().opening === id) set({ error: describe(cause) })
    } finally {
      if (mine === openingGeneration && get().opening === id) set({ opening: null })
    }
  },

  // The error goes with the session it belongs to. A sentence about an export
  // that failed has no meaning over the list of every session on the machine.
  close: () => {
    openingGeneration += 1
    set({ opened: null, opening: null, error: null })
  },

  copyOut: async (id, format) => {
    if (get().exporting) return false
    const rendered = await render(set, id, format)
    if (!rendered) return false

    try {
      // The webview's own clipboard rather than a plugin: this document is
      // served from localhost, a secure context on every platform this ships
      // on, and the menu click is the user gesture the API asks for.
      await navigator.clipboard.writeText(rendered.text)
      return true
    } catch (cause) {
      set({ error: reportFailure(cause) })
      return false
    }
  },

  saveOut: async (id, format, kind) => {
    if (get().exporting) return false
    const rendered = await render(set, id, format)
    if (!rendered) return false

    let path: string | null
    try {
      path = await pickPath({
        title: t('sessions.saveTitle'),
        defaultPath: rendered.name,
        filters: [{ name: kind, extensions: [suffix(rendered.name)] }],
      })
    } catch (cause) {
      set({ error: reportFailure(cause) })
      return false
    }
    // Dismissed, which is an answer rather than a failure.
    if (!path) return false

    try {
      await ipc.sessionSave(path, rendered.text)
      return true
    } catch (cause) {
      set({ error: reportFailure(cause) })
      return false
    }
  },
}))

/** One session, written out, or the sentence saying why it could not be. */
async function render(
  set: Write,
  id: string,
  format: ipc.SessionFormat,
): Promise<ipc.SessionExport | null> {
  set({ exporting: true, error: null })
  try {
    return await ipc.sessionExport(id, format)
  } catch (cause) {
    set({ error: reportFailure(cause) })
    return null
  } finally {
    // Off before the save dialog opens: waiting on a person is not work, and a
    // spinner behind a modal is a spinner nobody can see anyway.
    set({ exporting: false })
  }
}

/**
 * The extension the dialog should filter on.
 *
 * Taken off the name the native side suggested rather than restated here, so
 * the filter and the file can never disagree about what a format is called.
 */
function suffix(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1)
}

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

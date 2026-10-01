import { create } from 'zustand'
import * as ipc from '@/lib/ipc'
import type { PersonalLibrary, SavedPrompt, SessionAnnotation, SessionCard } from '@/lib/ipc'
import { describe } from '@/lib/errors'
import { reportFailure } from '@/state/failure'

export const emptyAnnotation = (): SessionAnnotation => ({
  title: '',
  pinned: false,
  tags: [],
  note: '',
  bookmarks: [],
})
const emptyLibrary = (): PersonalLibrary => ({ version: 1, sessions: {}, prompts: {} })

interface LibraryState {
  data: PersonalLibrary
  loaded: boolean
  loading: boolean
  busy: boolean
  editing: boolean
  error: string | null
  load: () => Promise<void>
  annotate: (id: string, patch: Partial<SessionAnnotation>) => Promise<boolean>
  annotateMany: (ids: string[], patch: ipc.BatchAnnotation) => Promise<boolean>
  importData: (
    source: string,
    preview: ipc.LibraryImportPreview,
    overwrite: boolean,
  ) => Promise<boolean>
  savePrompt: (prompt: SavedPrompt) => Promise<boolean>
  removePrompt: (id: string) => Promise<boolean>
}

let generation = 0
export const useLibrary = create<LibraryState>((set, get) => {
  const write = async (job: () => Promise<PersonalLibrary>): Promise<boolean> => {
    if (get().busy || !get().loaded) return false
    ++generation
    set({ busy: true, error: null })
    try {
      set({ data: await job() })
      return true
    } catch (cause) {
      set({ error: reportFailure(cause) })
      return false
    } finally {
      set({ busy: false })
    }
  }
  return {
    data: emptyLibrary(),
    loaded: false,
    loading: false,
    busy: false,
    editing: false,
    error: null,
    load: async () => {
      if (get().loading || get().busy) return
      const mine = ++generation
      set({ loading: true, error: null })
      try {
        const data = await ipc.libraryRead()
        if (mine === generation) set({ data, loaded: true })
      } catch (cause) {
        if (mine === generation) set({ error: describe(cause) })
      } finally {
        set({ loading: false })
      }
    },
    annotate: (id, patch) => write(() => ipc.sessionAnnotate(id, patch)),
    annotateMany: (ids, patch) => write(() => ipc.sessionAnnotateMany(ids, patch)),
    importData: (source, preview, overwrite) =>
      write(() => ipc.libraryImportApply(source, preview, overwrite)),
    savePrompt: (prompt) => write(() => ipc.promptSave(prompt)),
    removePrompt: (id) => write(() => ipc.promptRemove(id)),
  }
})

export const annotationFor = (
  annotations: PersonalLibrary['sessions'],
  id: string,
): SessionAnnotation | undefined => (Object.hasOwn(annotations, id) ? annotations[id] : undefined)

export const sessionTitle = (card: SessionCard, annotations: PersonalLibrary['sessions']): string =>
  annotationFor(annotations, card.id)?.title || card.title

/** Pins rank first without changing the runtime's own timestamps. */
export function organizeSessions(
  cards: SessionCard[],
  annotations: PersonalLibrary['sessions'],
  options: { pinned?: boolean; tag?: string; order?: 'recent' | 'oldest' | 'title' } = {},
): SessionCard[] {
  return cards
    .filter(
      (card) =>
        (!options.pinned || annotationFor(annotations, card.id)?.pinned) &&
        (!options.tag || annotationFor(annotations, card.id)?.tags.includes(options.tag)),
    )
    .sort(
      (a, b) =>
        Number(Boolean(annotationFor(annotations, b.id)?.pinned)) -
          Number(Boolean(annotationFor(annotations, a.id)?.pinned)) ||
        (options.order === 'title'
          ? sessionTitle(a, annotations).localeCompare(sessionTitle(b, annotations))
          : options.order === 'oldest'
            ? a.touched - b.touched
            : b.touched - a.touched) ||
        a.id.localeCompare(b.id),
    )
}

export function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
}

export function validTags(value: string): boolean {
  const tags = parseTags(value)
  return (
    tags.length <= 12 &&
    tags.every((tag) => [...tag].length <= 40 && !/[\u0000-\u001f\u007f]/.test(tag))
  )
}

/** Match annotations locally alongside native transcript search. */
export function annotationMatches(
  card: SessionCard,
  annotations: PersonalLibrary['sessions'],
  query: string,
): boolean {
  const item = annotationFor(annotations, card.id)
  if (!item || !query.trim()) return false
  const text = [item.title, item.note, ...item.tags].join(' ').toLocaleLowerCase()
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((term) => text.includes(term))
}

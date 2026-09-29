import { create } from 'zustand'
import { parsePresentation, type PresentationDocument } from '@/lib/presentation/document'
import { retainHistory } from '@/lib/presentation/authoring'
import { loadPresentation, savePresentation } from '@/lib/presentation/repository'
import { describe } from '@/lib/errors'

interface EditorState {
  document: PresentationDocument | null
  revision: string | null
  saved: string | null
  past: string[]
  future: string[]
  busy: 'load' | 'save' | 'update' | null
  lockForUpdate: () => boolean
  unlockUpdate: () => void
  error: string | null
  replace: (source: unknown, discard?: boolean) => boolean
  edit: (change: (draft: PresentationDocument) => void) => boolean
  undo: () => void
  redo: () => void
  open: (id: string, discard?: boolean) => Promise<boolean>
  save: () => Promise<boolean>
}

export const isPresentationDirty = (state: Pick<EditorState, 'document' | 'saved'>): boolean =>
  state.document !== null && JSON.stringify(state.document) !== state.saved

/** One editor owns its draft; switching panes does not discard pending changes. */
export function createPresentationEditor() {
  return create<EditorState>((set, get) => ({
    document: null,
    revision: null,
    saved: null,
    past: [],
    future: [],
    busy: null,
    error: null,
    lockForUpdate: () => {
      const state = get()
      if (state.busy || isPresentationDirty(state)) return false
      set({ busy: 'update' })
      return true
    },
    unlockUpdate: () => {
      if (get().busy === 'update') set({ busy: null })
    },
    replace: (source, discard = false) => {
      if (get().busy || (!discard && isPresentationDirty(get()))) return false
      try {
        const document = parsePresentation(source)
        set({ document, revision: null, saved: null, past: [], future: [], error: null })
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      }
    },
    edit: (change) => {
      const state = get()
      if (!state.document || (state.busy !== null && state.busy !== 'save')) return false
      try {
        const before = JSON.stringify(state.document)
        const draft = parsePresentation(state.document)
        change(draft)
        const document = parsePresentation(draft)
        if (document.id !== state.document.id) throw new Error('Document identity cannot be edited')
        if (JSON.stringify(document) === before) return true
        set({ document, past: retainHistory(state.past, before), future: [], error: null })
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      }
    },
    undo: () => {
      const state = get()
      if (!state.document || (state.busy !== null && state.busy !== 'save') || !state.past.length)
        return
      set({
        document: parsePresentation(JSON.parse(state.past.at(-1)!)),
        past: state.past.slice(0, -1),
        future: retainHistory(state.future, JSON.stringify(state.document)),
        error: null,
      })
    },
    redo: () => {
      const state = get()
      if (!state.document || (state.busy !== null && state.busy !== 'save') || !state.future.length)
        return
      set({
        document: parsePresentation(JSON.parse(state.future.at(-1)!)),
        future: state.future.slice(0, -1),
        past: retainHistory(state.past, JSON.stringify(state.document)),
        error: null,
      })
    },
    open: async (id, discard = false) => {
      if (get().busy || (!discard && isPresentationDirty(get()))) return false
      set({ busy: 'load', error: null })
      try {
        const saved = await loadPresentation(id)
        if (!saved) throw new Error('The presentation no longer exists')
        set({
          document: saved.document,
          revision: saved.revision,
          saved: JSON.stringify(saved.document),
          past: [],
          future: [],
        })
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      } finally {
        set({ busy: null })
      }
    },
    save: async () => {
      const state = get()
      if (state.busy || !state.document) return false
      const snapshot = parsePresentation(state.document)
      set({ busy: 'save', error: null })
      try {
        const saved = await savePresentation(snapshot, state.revision)
        // Edits made while disk I/O runs remain dirty. Never replace the live draft.
        set({ revision: saved.revision, saved: JSON.stringify(saved.document) })
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      } finally {
        set({ busy: null })
      }
    },
  }))
}

export const usePresentationEditor = createPresentationEditor()

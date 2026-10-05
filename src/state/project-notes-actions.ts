import * as ipc from '@/lib/ipc'
import type { ProjectNoteInput } from '@/lib/ipc'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import { notesDirty, useProjectNotes } from '@/state/project-notes'

const content = (note: ProjectNoteInput) => JSON.stringify([note.id, note.title, note.body])

let timer: ReturnType<typeof setTimeout> | null = null
const cancelSave = () => {
  if (timer !== null) clearTimeout(timer)
  timer = null
}
const scheduleSave = () => {
  cancelSave()
  timer = setTimeout(() => {
    timer = null
    void useProjectNotes.getState().save()
  }, 500)
}

const get = useProjectNotes.getState
const set = useProjectNotes.setState
/** Loaded on demand. Saving older text never erases typing that arrived during IPC. */
export const actions = {
  load: async () => {
    const state = get()
    if (state.busy || state.locked || notesDirty(state)) return false
    cancelSave()
    set({ busy: 'load', error: null })
    try {
      const collection = await ipc.workspaceNotes()
      const draft =
        collection.notes.find(
          (note) => state.root === collection.root && note.id === state.draft?.id,
        ) ?? null
      set({
        root: collection.root,
        notes: collection.notes,
        recovered: collection.drafts,
        draft,
        saved: draft ? content(draft) : null,
      })
      return true
    } catch (cause) {
      set({ error: describe(cause) })
      return false
    } finally {
      set({ busy: null })
    }
  },
  choose: async (id: string | null) => {
    if (get().busy || get().locked || !get().root) return false
    if (!(await get().save())) return false
    const draft =
      id === null
        ? { id: crypto.randomUUID(), title: t('notes.untitled'), body: '', revision: 0 }
        : get().notes.find((note) => note.id === id)
    if (!draft) return false
    set({ draft: { ...draft }, saved: id === null ? null : content(draft), error: null })
    if (id === null) scheduleSave()
    return true
  },
  change: (patch: Partial<Pick<ProjectNoteInput, 'title' | 'body'>>) => {
    const state = get()
    if (!state.draft || state.locked || (state.busy !== null && state.busy !== 'save')) return false
    set({ draft: { ...state.draft, ...patch }, error: null })
    if (state.busy !== 'save') scheduleSave()
    return true
  },
  save: async () => {
    const state = get()
    if (state.busy || state.locked) return false
    if (!state.draft || !notesDirty(state)) return true
    if (!state.root) return false
    cancelSave()
    const snapshot = { ...state.draft, title: state.draft.title.trim() || t('notes.untitled') }
    const editor = state.editor ?? crypto.randomUUID()
    set({ busy: 'save', error: null, editor })
    let success = false
    try {
      await ipc.workspaceNoteCheckpoint(state.root, snapshot, editor)
      const note = await ipc.workspaceNoteSave(state.root, snapshot, editor)
      const current = get().draft
      set({
        notes: [note, ...get().notes.filter((item) => item.id !== note.id)],
        recovered: get().recovered.filter((item) => item.editor !== editor),
        draft: current
          ? {
              ...current,
              title: current.title === state.draft.title ? note.title : current.title,
              revision: note.revision,
            }
          : null,
        saved: content(note),
      })
      success = true
      return true
    } catch (cause) {
      set({ error: describe(cause) })
      return false
    } finally {
      set({ busy: null })
      if (success && notesDirty(get())) scheduleSave()
    }
  },
  remove: async (id: string) => {
    if (get().busy || get().locked) return false
    if (!(await get().save())) return false
    const state = get(),
      note = state.notes.find((item) => item.id === id)
    if (!state.root || !note) return false
    cancelSave()
    set({ busy: 'remove', error: null })
    try {
      await ipc.workspaceNoteRemove(state.root, note.id, note.revision)
      set({
        notes: get().notes.filter((item) => item.id !== id),
        ...(get().draft?.id === id ? { draft: null, saved: null } : {}),
      })
      return true
    } catch (cause) {
      set({ error: describe(cause) })
      return false
    } finally {
      set({ busy: null })
    }
  },
  saveCopy: async () => {
    const state = get()
    if (!state.draft || !state.root || state.busy || state.locked) return false
    set({
      draft: {
        ...state.draft,
        id: crypto.randomUUID(),
        title: t('notes.recoveredCopy', {
          title: Array.from(state.draft.title).slice(0, 200).join(''),
        }),
        revision: 0,
      },
      saved: null,
    })
    return get().save()
  },
  recover: async (editor: string) => {
    if (get().busy || get().locked || !get().root || !(await get().save())) return false
    const source = get().recovered.find((item) => item.editor === editor)
    if (!source) return false
    set({
      draft: {
        ...source.note,
        id: crypto.randomUUID(),
        title: t('notes.recoveredCopy', {
          title: Array.from(source.note.title).slice(0, 200).join(''),
        }),
        revision: 0,
      },
      saved: null,
      error: null,
    })
    scheduleSave()
    return true
  },
  discardDraft: async (editor: string) => {
    const state = get(),
      source = state.recovered.find((item) => item.editor === editor)
    if (!state.root || !source || state.busy || state.locked || notesDirty(state)) return false
    set({ busy: 'remove', error: null })
    try {
      await ipc.workspaceNoteDraftRemove(state.root, editor, source.revision)
      set({ recovered: get().recovered.filter((item) => item.editor !== editor) })
      return true
    } catch (cause) {
      set({ error: describe(cause) })
      return false
    } finally {
      set({ busy: null })
    }
  },
}

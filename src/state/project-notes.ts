import { create } from 'zustand'
import type { ProjectNote, ProjectNoteInput, ProjectNoteDraft } from '@/lib/ipc'
import { t } from '@/lib/i18n'

interface NotesState {
  root: string | null
  notes: ProjectNote[]
  recovered: ProjectNoteDraft[]
  editor: string | null
  draft: ProjectNoteInput | null
  saved: string | null
  busy: 'load' | 'save' | 'remove' | null
  locked: boolean
  error: string | null
  load: () => Promise<boolean>
  choose: (id: string | null) => Promise<boolean>
  change: (patch: Partial<Pick<ProjectNoteInput, 'title' | 'body'>>) => boolean
  save: () => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  recover: (editor: string) => Promise<boolean>
  discardDraft: (editor: string) => Promise<boolean>
  saveCopy: () => Promise<boolean>
  lock: () => boolean
  unlock: () => void
}

export const notesDirty = (state: Pick<NotesState, 'draft' | 'saved'>) =>
  state.draft !== null &&
  JSON.stringify([state.draft.id, state.draft.title, state.draft.body]) !== state.saved

type Actions = Pick<
  NotesState,
  'load' | 'choose' | 'change' | 'save' | 'remove' | 'recover' | 'discardDraft' | 'saveCopy'
>
let loaded: Actions | null = null
const actions = async (): Promise<Actions | null> => {
  if (loaded) return loaded
  try {
    loaded = (await import('./project-notes-actions')).actions
  } catch {
    useProjectNotes.setState({ error: t('notes.loadFailed') })
  }
  return loaded
}

/** Lifecycle guards stay eager; editor IPC and persistence load only when needed. */
export const useProjectNotes = create<NotesState>((set, get) => ({
  root: null,
  notes: [],
  recovered: [],
  editor: null,
  draft: null,
  saved: null,
  busy: null,
  locked: false,
  error: null,
  load: () => (loaded ? loaded.load() : actions().then((api) => api?.load() ?? false)),
  choose: (id) => (loaded ? loaded.choose(id) : actions().then((api) => api?.choose(id) ?? false)),
  change: (patch) => loaded?.change(patch) ?? false,
  save: () => {
    if (get().locked || get().busy) return Promise.resolve(false)
    if (!notesDirty(get())) return Promise.resolve(true)
    return loaded ? loaded.save() : actions().then((api) => api?.save() ?? false)
  },
  remove: (id) => (loaded ? loaded.remove(id) : actions().then((api) => api?.remove(id) ?? false)),
  recover: (id) =>
    loaded ? loaded.recover(id) : actions().then((api) => api?.recover(id) ?? false),
  discardDraft: (id) =>
    loaded ? loaded.discardDraft(id) : actions().then((api) => api?.discardDraft(id) ?? false),
  saveCopy: () => (loaded ? loaded.saveCopy() : actions().then((api) => api?.saveCopy() ?? false)),
  lock: () => {
    if (get().locked || get().busy || notesDirty(get())) return false
    set({ locked: true })
    return true
  },
  unlock: () => set({ locked: false }),
}))

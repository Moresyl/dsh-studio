import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ipc from '@/lib/ipc'
import type { ProjectNote, ProjectNotes } from '@/lib/ipc'
import { notesDirty, useProjectNotes as store } from '@/state/project-notes'
vi.mock('@/lib/ipc')

const note = (id = 'one', body = 'saved'): ProjectNote => ({
  id,
  title: 'Project',
  body,
  revision: 1,
  updated: 100,
})
const collection = (): ProjectNotes => ({
  root: 'D:/project',
  notes: [note()],
  drafts: [{ editor: 'old-editor', note: note('old', 'recovered text'), revision: 'a'.repeat(64) }],
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  store.setState({
    root: null,
    notes: [],
    recovered: [],
    editor: null,
    draft: null,
    saved: null,
    busy: null,
    locked: false,
    error: null,
  })
  vi.mocked(ipc.workspaceNotes).mockResolvedValue(collection())
  vi.mocked(ipc.workspaceNoteCheckpoint).mockResolvedValue(undefined)
  vi.mocked(ipc.workspaceNoteSave).mockImplementation(async (_, input) => ({
    ...input,
    revision: input.revision + 1,
    updated: 200,
  }))
  vi.mocked(ipc.workspaceNoteRemove).mockResolvedValue(undefined)
  vi.mocked(ipc.workspaceNoteDraftRemove).mockResolvedValue(undefined)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('project notes and durable draft checkpoints', () => {
  it('loads recoverable drafts and keeps selection when the same workspace refreshes', async () => {
    expect(await store.getState().load()).toBe(true)
    expect(await store.getState().choose('one')).toBe(true)
    expect(notesDirty(store.getState())).toBe(false)
    expect(await store.getState().save()).toBe(true)
    expect(ipc.workspaceNoteSave).not.toHaveBeenCalled()
    expect(await store.getState().load()).toBe(true)
    expect(store.getState().draft?.id).toBe('one')
    vi.mocked(ipc.workspaceNotes).mockResolvedValue({
      root: 'D:/other',
      notes: [note()],
      drafts: [],
    })
    await store.getState().load()
    expect(store.getState().draft).toBeNull()
    expect(store.getState().recovered).toEqual([])
    expect(await store.getState().choose('missing')).toBe(false)
  })
  it('debounces typing, checkpoints before committing and restores clean content', async () => {
    await store.getState().load()
    await store.getState().choose(null)
    store.getState().change({ body: '第一次' })
    await vi.advanceTimersByTimeAsync(300)
    store.getState().change({ body: '最终内容', title: '   ' })
    await vi.advanceTimersByTimeAsync(499)
    expect(ipc.workspaceNoteCheckpoint).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const state = store.getState()
    expect(state.draft?.body).toBe('最终内容')
    expect(state.draft?.title.trim()).not.toBe('')
    expect(notesDirty(state)).toBe(false)
    expect(ipc.workspaceNoteCheckpoint).toHaveBeenCalledOnce()
    expect(vi.mocked(ipc.workspaceNoteCheckpoint).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ipc.workspaceNoteSave).mock.invocationCallOrder[0]!,
    )
    expect(ipc.workspaceNoteSave).toHaveBeenCalledWith(
      'D:/project',
      expect.objectContaining({ body: '最终内容', revision: 0 }),
      state.editor,
    )
  })
  it('keeps text typed during an in-flight save and commits it using the returned revision', async () => {
    await store.getState().load()
    await store.getState().choose('one')
    store.getState().change({ body: 'snapshot' })
    let done!: (note: ProjectNote) => void
    vi.mocked(ipc.workspaceNoteSave).mockReturnValueOnce(
      new Promise((resolve) => {
        done = resolve
      }),
    )
    const pending = store.getState().save()
    await Promise.resolve()
    expect(store.getState().change({ body: 'new typing', title: 'new title' })).toBe(true)
    expect(await store.getState().choose(null)).toBe(false)
    expect(await store.getState().save()).toBe(false)
    expect(store.getState().lock()).toBe(false)
    done({ ...note('one', 'snapshot'), revision: 2 })
    await pending
    expect(store.getState().draft).toMatchObject({
      body: 'new typing',
      title: 'new title',
      revision: 2,
    })
    expect(notesDirty(store.getState())).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(ipc.workspaceNoteSave).toHaveBeenLastCalledWith(
      'D:/project',
      expect.objectContaining({ body: 'new typing', title: 'new title', revision: 2 }),
      expect.any(String),
    )
    expect(notesDirty(store.getState())).toBe(false)
  })
  it('retains a conflicting draft, refuses refresh and allows saving a new copy', async () => {
    await store.getState().load()
    await store.getState().choose('one')
    store.getState().change({ body: 'my changes' })
    vi.mocked(ipc.workspaceNoteSave).mockRejectedValueOnce(new Error('revision conflict'))
    expect(await store.getState().save()).toBe(false)
    expect(store.getState()).toMatchObject({
      busy: null,
      error: 'revision conflict',
      draft: { id: 'one', body: 'my changes', revision: 1 },
    })
    expect(await store.getState().load()).toBe(false)
    expect(await store.getState().choose(null)).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    await store.getState().choose('one')
    store.getState().change({ body: 'a safe copy' })
    expect(await store.getState().saveCopy()).toBe(true)
    expect(store.getState().draft?.id).not.toBe('one')
    expect(store.getState().notes.find((item) => item.id === 'one')?.body).toBe('my changes')
    expect(store.getState().draft?.body).toBe('a safe copy')
  })
  it('does not commit if its checkpoint fails and preserves the recoverable error', async () => {
    await store.getState().load()
    await store.getState().choose('one')
    store.getState().change({ body: 'kept in editor' })
    vi.mocked(ipc.workspaceNoteCheckpoint).mockRejectedValue(new Error('disk full'))
    expect(await store.getState().save()).toBe(false)
    expect(ipc.workspaceNoteSave).not.toHaveBeenCalled()
    expect(store.getState().draft?.body).toBe('kept in editor')
    expect(store.getState().error).toBe('disk full')
    expect(await store.getState().remove('one')).toBe(false)
    expect(await store.getState().recover('old-editor')).toBe(false)
    expect(await store.getState().discardDraft('old-editor')).toBe(false)
  })
  it('restores as a new note and requires the reviewed hash before discarding a backup', async () => {
    await store.getState().load()
    expect(await store.getState().recover('missing')).toBe(false)
    expect(await store.getState().recover('old-editor')).toBe(true)
    expect(store.getState().draft).toMatchObject({ body: 'recovered text', revision: 0 })
    expect(store.getState().draft?.id).not.toBe('old')
    expect(await store.getState().discardDraft('old-editor')).toBe(false)
    await store.getState().save()
    expect(await store.getState().discardDraft('old-editor')).toBe(true)
    expect(ipc.workspaceNoteDraftRemove).toHaveBeenCalledWith(
      'D:/project',
      'old-editor',
      'a'.repeat(64),
    )
    expect(store.getState().recovered).toEqual([])
    expect(store.getState().notes.some((item) => item.body === 'recovered text')).toBe(true)
    expect(await store.getState().discardDraft('missing')).toBe(false)
  })
  it('preserves a backup when another window changes it and supports retry', async () => {
    await store.getState().load()
    vi.mocked(ipc.workspaceNoteDraftRemove).mockRejectedValueOnce(new Error('changed backup'))
    expect(await store.getState().discardDraft('old-editor')).toBe(false)
    expect(store.getState().recovered).toHaveLength(1)
    expect(await store.getState().discardDraft('old-editor')).toBe(true)
  })
  it('removes only the exact saved revision and retains notes after delete failure', async () => {
    await store.getState().load()
    await store.getState().choose('one')
    vi.mocked(ipc.workspaceNoteRemove).mockRejectedValueOnce(new Error('changed note'))
    expect(await store.getState().remove('one')).toBe(false)
    expect(store.getState().notes).toHaveLength(1)
    expect(store.getState().draft?.id).toBe('one')
    expect(await store.getState().remove('one')).toBe(true)
    expect(ipc.workspaceNoteRemove).toHaveBeenCalledWith('D:/project', 'one', 1)
    expect(store.getState().draft).toBeNull()
    expect(await store.getState().remove('one')).toBe(false)
  })
  it('guards update leases, absent workspaces and pending loads', async () => {
    expect(store.getState().change({ body: 'ignored' })).toBe(false)
    expect(await store.getState().choose(null)).toBe(false)
    expect(await store.getState().saveCopy()).toBe(false)
    expect(store.getState().lock()).toBe(true)
    expect(await store.getState().load()).toBe(false)
    expect(await store.getState().save()).toBe(false)
    expect(await store.getState().remove('one')).toBe(false)
    expect(await store.getState().recover('old-editor')).toBe(false)
    store.getState().unlock()
    let resolve!: (value: ProjectNotes) => void
    vi.mocked(ipc.workspaceNotes).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const pending = store.getState().load()
    expect(await store.getState().load()).toBe(false)
    expect(store.getState().change({ body: 'ignored' })).toBe(false)
    expect(await store.getState().discardDraft('old-editor')).toBe(false)
    resolve(collection())
    await pending
    await store.getState().choose('one')
    expect(store.getState().lock()).toBe(true)
    expect(store.getState().change({ body: 'blocked' })).toBe(false)
    store.getState().unlock()
  })
  it('reports load failure without losing a previous clean note', async () => {
    await store.getState().load()
    await store.getState().choose('one')
    vi.mocked(ipc.workspaceNotes).mockRejectedValueOnce(new Error('damaged file'))
    expect(await store.getState().load()).toBe(false)
    expect(store.getState().draft?.body).toBe('saved')
    expect(store.getState().error).toBe('damaged file')
    store.setState({ root: null, saved: null })
    expect(await store.getState().save()).toBe(false)
  })
})

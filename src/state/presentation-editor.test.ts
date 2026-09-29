import { beforeEach, expect, it, vi } from 'vitest'
const repository = vi.hoisted(() => ({ loadPresentation: vi.fn(), savePresentation: vi.fn() }))
vi.mock('@/lib/presentation/repository', () => repository)
import { createPresentationEditor, isPresentationDirty } from './presentation-editor'
import { fixture } from '@/lib/presentation/fixtures.test-support'
import { newPresentation, blankSlide, retainHistory } from '@/lib/presentation/authoring'

beforeEach(() => vi.resetAllMocks())
const revision = 'a'.repeat(64)

it('creates independent valid blank documents and bounds history memory and count', () => {
  const first = newPresentation('中文')
  const second = newPresentation('Second')
  expect(first.id).not.toBe(second.id)
  expect(first.slides[0]!.id).not.toBe(blankSlide('Next').id)
  expect(first.slides[0]!.elements).toEqual([])
  expect(retainHistory(Array(100).fill('old'), 'new')).toHaveLength(100)
  expect(retainHistory(['a'.repeat(4 * 1024 * 1024)], 'new')).toEqual(['new'])
  expect(retainHistory([], 'a'.repeat(4 * 1024 * 1024 + 1))).toEqual([])
})

it('keeps immutable valid edits, undo/redo and rejects invalid edits without losing history', () => {
  const store = createPresentationEditor()
  const source = fixture()
  expect(store.getState().replace(source)).toBe(true)
  store.getState().edit((draft) => {
    draft.title = 'Changed'
  })
  expect(source.title).not.toBe('Changed')
  expect(store.getState().document!.title).toBe('Changed')
  store.getState().undo()
  expect(store.getState().document).toEqual(source)
  store.getState().redo()
  expect(store.getState().document!.title).toBe('Changed')
  expect(
    store.getState().edit((draft) => {
      draft.id = 'other'
    }),
  ).toBe(false)
  expect(
    store.getState().edit((draft) => {
      draft.slides = []
    }),
  ).toBe(false)
  expect(store.getState().past).toHaveLength(1)
  store.getState().undo()
  store.getState().edit((draft) => {
    draft.title = 'Branch'
  })
  expect(store.getState().future).toEqual([])
  store.getState().edit(() => {})
  expect(store.getState().past).toHaveLength(1)
})

it('never replaces a dirty draft without an explicit discard decision', async () => {
  const store = createPresentationEditor()
  store.getState().replace(fixture())
  expect(store.getState().replace(newPresentation('Other'))).toBe(false)
  expect(await store.getState().open('other')).toBe(false)
  expect(repository.loadPresentation).not.toHaveBeenCalled()
  expect(store.getState().replace({}, true)).toBe(false)
  expect(store.getState().document).toEqual(fixture())
  expect(store.getState().replace(newPresentation('Other'), true)).toBe(true)
})

it('keeps edits made during save dirty and uses the new revision on the next save', async () => {
  const store = createPresentationEditor()
  store.getState().replace(fixture())
  let finish!: (value: unknown) => void
  repository.savePresentation.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const saving = store.getState().save()
  expect(await store.getState().save()).toBe(false)
  expect(store.getState().replace(newPresentation('Other'), true)).toBe(false)
  expect(await store.getState().open('other', true)).toBe(false)
  store.getState().edit((draft) => {
    draft.title = 'New edits'
  })
  finish({ document: fixture(), revision })
  expect(await saving).toBe(true)
  expect(store.getState().document!.title).toBe('New edits')
  expect(isPresentationDirty(store.getState())).toBe(true)
  repository.savePresentation.mockResolvedValue({ document: store.getState().document, revision })
  await store.getState().save()
  expect(repository.savePresentation).toHaveBeenLastCalledWith(store.getState().document, revision)
  expect(isPresentationDirty(store.getState())).toBe(false)
  store.getState().undo()
  expect(isPresentationDirty(store.getState())).toBe(true)
  store.getState().redo()
  expect(isPresentationDirty(store.getState())).toBe(false)
})

it('preserves the draft and revision after save conflicts and failed loads', async () => {
  const store = createPresentationEditor()
  repository.loadPresentation.mockResolvedValue({ document: fixture(), revision })
  expect(await store.getState().open('fixture')).toBe(true)
  expect(isPresentationDirty(store.getState())).toBe(false)
  store.getState().edit((draft) => {
    draft.title = 'Unsaved'
  })
  repository.savePresentation.mockRejectedValue(new Error('Conflict'))
  expect(await store.getState().save()).toBe(false)
  expect(store.getState().revision).toBe(revision)
  expect(store.getState().document!.title).toBe('Unsaved')
  repository.loadPresentation.mockResolvedValue(null)
  expect(await store.getState().open('missing', true)).toBe(false)
  expect(store.getState().document!.title).toBe('Unsaved')
  expect(store.getState().busy).toBeNull()
})

it('blocks edits and history navigation during load and handles empty editor actions', async () => {
  const store = createPresentationEditor()
  expect(store.getState().edit(() => {})).toBe(false)
  expect(await store.getState().save()).toBe(false)
  store.getState().undo()
  store.getState().redo()
  store.getState().replace(fixture())
  store.getState().edit((draft) => {
    draft.title = 'Before'
  })
  let finish!: (value: unknown) => void
  repository.loadPresentation.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const loading = store.getState().open('fixture', true)
  expect(store.getState().edit(() => {})).toBe(false)
  store.getState().undo()
  store.getState().redo()
  expect(store.getState().document!.title).toBe('Before')
  finish({ document: fixture(), revision })
  expect(await loading).toBe(true)
  expect(store.getState().past).toEqual([])
  expect(store.getState().future).toEqual([])
})

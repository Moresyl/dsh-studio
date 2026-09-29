import { beforeEach, expect, it, vi } from 'vitest'
const repository = vi.hoisted(() => ({ loadPresentation: vi.fn(), savePresentation: vi.fn() }))
vi.mock('./repository', () => repository)
import { copyPresentation } from './authoring'
import { fixture } from './fixtures.test-support'
import { parsePresentation, PRESENTATION_TITLE_LIMIT } from './document'
import { createPresentationEditor, isPresentationDirty } from '@/state/presentation-editor'

beforeEach(() => vi.resetAllMocks())

it('copies editable content deeply while replacing document, page and object identities', () => {
  const source = fixture()
  const copy = copyPresentation(source, '副本')
  expect(copy.id).not.toBe(source.id)
  expect(copy.title).toBe(source.title + ' (副本)')
  expect(copy.slides[0]!.id).not.toBe(source.slides[0]!.id)
  copy.slides[0]!.elements.forEach((element, index) => {
    const original = source.slides[0]!.elements[index]!
    expect(element.id).not.toBe(original.id)
    expect({ ...element, id: original.id }).toEqual(original)
  })
  copy.slides[0]!.notes = 'Independent'
  expect(source).toEqual(fixture())
  expect(copyPresentation(source, '副本').id).not.toBe(copy.id)
})

it('bounds long copy titles without splitting a supplementary Unicode character', () => {
  const source = fixture()
  source.title = 'x'.repeat(154) + '😀😀😀'
  const copy = copyPresentation(source, '副本')
  expect(copy.title).toBe('x'.repeat(154) + ' (副本)')
  expect(copy.title.length).toBeLessThanOrEqual(PRESENTATION_TITLE_LIMIT)
  expect(parsePresentation(copy)).toEqual(copy)
})

it.each(['', ' ', 'x'.repeat(81), 'invalid\u0000suffix'])(
  'rejects an invalid copy suffix %j',
  (suffix) => {
    expect(() => copyPresentation(fixture(), suffix)).toThrow()
  },
)

it('saves a new create-only document including pending input, then opens the saved copy', async () => {
  const editor = createPresentationEditor()
  editor.getState().replace(fixture())
  editor.setState({ revision: 'b'.repeat(64) })
  editor.getState().stageInput('notes', {
    label: 'Notes',
    value: 'Uncommitted notes',
    commit: (value) =>
      editor.getState().edit((draft) => {
        draft.slides[0]!.notes = value
      }),
  })
  repository.savePresentation.mockImplementation(async (document) => ({
    document,
    revision: 'a'.repeat(64),
  }))
  expect(await editor.getState().saveCopy('副本')).toBe(true)
  const [copy, expected] = repository.savePresentation.mock.calls[0]!
  expect(expected).toBeNull()
  expect(copy.id).not.toBe(fixture().id)
  expect(copy.slides[0].notes).toBe('Uncommitted notes')
  expect(editor.getState()).toMatchObject({
    document: copy,
    revision: 'a'.repeat(64),
    inputs: {},
    past: [],
    future: [],
    busy: null,
  })
  expect(isPresentationDirty(editor.getState())).toBe(false)
})

it('locks source mutation and coalesces repeated requests during copy persistence', async () => {
  const editor = createPresentationEditor()
  editor.getState().replace(fixture())
  let finish!: (value: unknown) => void
  repository.savePresentation.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const pending = editor.getState().saveCopy('Copy')
  expect(editor.getState().busy).toBe('copy')
  expect(
    editor.getState().edit((draft) => {
      draft.title = 'Blocked'
    }),
  ).toBe(false)
  expect(editor.getState().replace(fixture(), true)).toBe(false)
  expect(await editor.getState().saveCopy('Copy')).toBe(false)
  expect(await editor.getState().save()).toBe(false)
  expect(editor.getState().lockForUpdate()).toBe(false)
  expect(repository.savePresentation).toHaveBeenCalledOnce()
  finish({ document: repository.savePresentation.mock.calls[0]![0], revision: 'a'.repeat(64) })
  expect(await pending).toBe(true)
  expect(editor.getState().busy).toBeNull()
})

it('preserves the source, revision and undo history on a failed copy', async () => {
  const editor = createPresentationEditor()
  editor.getState().replace(fixture())
  editor.getState().edit((draft) => {
    draft.title = 'Unsaved work'
  })
  editor.setState({ revision: 'b'.repeat(64) })
  const before = editor.getState()
  repository.savePresentation.mockRejectedValue(new Error('Library is full'))
  expect(await editor.getState().saveCopy('Copy')).toBe(false)
  expect(editor.getState()).toMatchObject({
    document: before.document,
    revision: before.revision,
    past: before.past,
    saved: before.saved,
    busy: null,
    error: 'Library is full',
  })
})

it('does not create a copy for invalid unfinished input or an empty editor', async () => {
  const editor = createPresentationEditor()
  expect(await editor.getState().saveCopy('Copy')).toBe(false)
  editor.getState().replace(fixture())
  editor.getState().stageInput('invalid', { label: 'Width', value: '-', commit: () => false })
  expect(await editor.getState().saveCopy('Copy')).toBe(false)
  expect(repository.savePresentation).not.toHaveBeenCalled()
  expect(editor.getState().inputs.invalid!.value).toBe('-')
})

import { beforeEach, expect, it, vi } from 'vitest'
const repository = vi.hoisted(() => ({ loadPresentation: vi.fn(), savePresentation: vi.fn() }))
vi.mock('@/lib/presentation/repository', () => repository)
import { createPresentationEditor, isPresentationDirty } from './presentation-editor'
import { fixture } from '@/lib/presentation/fixtures.test-support'

beforeEach(() => vi.resetAllMocks())
function setup() {
  const editor = createPresentationEditor()
  const document = fixture()
  editor.setState({ document, saved: JSON.stringify(document) })
  const stage = (value: string) =>
    editor.getState().stageInput('title', {
      label: 'Title',
      value,
      commit: (next) =>
        editor.getState().edit((draft) => {
          draft.title = next
        }),
    })
  return { editor, stage }
}

it('treats input as dirty before blur and refuses implicit replacement or update', async () => {
  const { editor, stage } = setup()
  stage('Still typing')
  expect(isPresentationDirty(editor.getState())).toBe(true)
  expect(editor.getState().document!.title).toBe(fixture().title)
  expect(editor.getState().lockForUpdate()).toBe(false)
  expect(editor.getState().replace(fixture())).toBe(false)
  expect(await editor.getState().open('other')).toBe(false)
  expect(repository.loadPresentation).not.toHaveBeenCalled()
  expect(editor.getState().inputs.title!.value).toBe('Still typing')
})

it('commits a field once and saves it even if its component no longer exists', async () => {
  const { editor, stage } = setup()
  stage('First keystroke')
  stage('Last keystroke')
  repository.savePresentation.mockImplementation(async (document) => ({
    document,
    revision: 'a'.repeat(64),
  }))
  expect(await editor.getState().save()).toBe(true)
  expect(repository.savePresentation.mock.calls[0]![0].title).toBe('Last keystroke')
  expect(editor.getState().inputs).toEqual({})
  expect(editor.getState().past).toHaveLength(1)
  expect(isPresentationDirty(editor.getState())).toBe(false)
  expect(editor.getState().commitInput('title')).toBe(true)
  expect(editor.getState().past).toHaveLength(1)
  editor.getState().undo()
  expect(editor.getState().document!.title).toBe(fixture().title)
})

it('keeps invalid input, blocks save and unrelated mutations, and supports correction', async () => {
  const { editor, stage } = setup()
  stage('')
  expect(await editor.getState().save()).toBe(false)
  expect(editor.getState().inputs.title!.value).toBe('')
  expect(repository.savePresentation).not.toHaveBeenCalled()
  expect(
    editor.getState().edit((draft) => {
      draft.slides = []
    }),
  ).toBe(false)
  expect(editor.getState().document).toEqual(fixture())
  editor.getState().undo()
  editor.getState().redo()
  expect(editor.getState().inputs.title!.value).toBe('')
  stage('Corrected')
  expect(editor.getState().flushInputs()).toBe(true)
  expect(editor.getState().document!.title).toBe('Corrected')
})

it('allows explicit input discard or document replacement without leaving stale callbacks', () => {
  const { editor, stage } = setup()
  stage('Cancelled')
  editor.getState().discardInput('title')
  expect(isPresentationDirty(editor.getState())).toBe(false)
  stage('Discarded with document')
  expect(editor.getState().replace(fixture(), true)).toBe(true)
  expect(editor.getState().inputs).toEqual({})
  expect(editor.getState().commitInput('title')).toBe(true)
  expect(editor.getState().document).toEqual(fixture())
})

it('retains input exceptions and resets the internal commit guard', () => {
  const { editor } = setup()
  editor.getState().stageInput('fault', {
    label: 'Fault',
    value: 'Kept',
    commit: () => {
      throw new Error('Failed field')
    },
  })
  expect(editor.getState().flushInputs()).toBe(false)
  expect(editor.getState().error).toBe('Failed field')
  expect(editor.getState().inputs.fault!.value).toBe('Kept')
  expect(
    editor.getState().edit((draft) => {
      draft.title = 'Blocked'
    }),
  ).toBe(false)
})

it.each(['load', 'update', 'synchronizing'] as const)(
  'refuses staging or discarding fields during %s',
  (busy) => {
    const { editor, stage } = setup()
    stage('Existing')
    editor.setState({ busy })
    stage('Rejected')
    editor.getState().discardInput('title')
    expect(editor.getState().inputs.title!.value).toBe('Existing')
    expect(editor.getState().commitInput('title')).toBe(false)
  },
)

it('leaves new input dirty when an earlier save finishes', async () => {
  const { editor, stage } = setup()
  let finish!: (value: unknown) => void
  repository.savePresentation.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const saving = editor.getState().save()
  stage('Typed during disk I/O')
  finish({ document: fixture(), revision: 'a'.repeat(64) })
  expect(await saving).toBe(true)
  expect(isPresentationDirty(editor.getState())).toBe(true)
  expect(editor.getState().lockForUpdate()).toBe(false)
  expect(editor.getState().inputs.title!.value).toBe('Typed during disk I/O')
})

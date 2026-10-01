import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const repository = vi.hoisted(() => ({ loadPresentation: vi.fn(), savePresentation: vi.fn() }))
vi.mock('@/lib/presentation/repository', () => repository)
import { isPresentationDirty, usePresentationEditor as editor } from '@/state/presentation-editor'
import { fixture } from './fixtures.test-support'
import { canAutomaticallyReload, reloadPreservingPresentation } from './renderer-recovery'
import { useLibrary } from '@/state/library'

beforeEach(() => {
  vi.resetAllMocks()
  useLibrary.setState({ editing: false, busy: false })
  editor.setState({
    document: null,
    revision: null,
    saved: null,
    past: [],
    future: [],
    busy: null,
    error: null,
    inputs: {},
  })
})
afterEach(() => vi.unstubAllGlobals())

it('blocks recovery reloads while a personal edit or write is pending', async () => {
  const reload = vi.fn()
  useLibrary.setState({ editing: true })
  expect(canAutomaticallyReload()).toBe(false)
  expect(await reloadPreservingPresentation(reload, false)).toBe(false)
  await expect(reloadPreservingPresentation(reload)).rejects.toThrow()
  expect(reload).not.toHaveBeenCalled()
})

it('keeps the editor locked while asynchronous reload preparation runs and unlocks on failure', async () => {
  let reject!: (cause: Error) => void
  const operation = reloadPreservingPresentation(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail
      }),
  )
  expect(editor.getState().busy).toBe('update')
  expect(editor.getState().replace(fixture())).toBe(false)
  reject(new Error('Preparation failed'))
  await expect(operation).rejects.toThrow('Preparation failed')
  expect(editor.getState().busy).toBeNull()
})

it('saves unfinished input retained after the editor component unmounts', async () => {
  const document = fixture()
  editor.setState({ document, saved: JSON.stringify(document) })
  editor.getState().stageInput('title', {
    label: 'Title',
    value: 'Uncommitted title',
    commit: (value) =>
      editor.getState().edit((draft) => {
        draft.title = value
      }),
  })
  expect(canAutomaticallyReload()).toBe(false)
  repository.savePresentation.mockImplementation(async (document) => ({
    document,
    revision: 'a'.repeat(64),
  }))
  const reload = vi.fn()
  expect(await reloadPreservingPresentation(reload)).toBe(true)
  expect(repository.savePresentation.mock.calls[0]![0].title).toBe('Uncommitted title')
  expect(reload).toHaveBeenCalledOnce()
})

it('refuses to reload invalid unfinished input and retains its editable value', async () => {
  editor.getState().replace(fixture())
  editor.getState().stageInput('invalid', { label: 'Width', value: '-', commit: () => false })
  const reload = vi.fn()
  await expect(reloadPreservingPresentation(reload)).rejects.toThrow()
  expect(reload).not.toHaveBeenCalled()
  expect(repository.savePresentation).not.toHaveBeenCalled()
  expect(editor.getState().inputs.invalid!.value).toBe('-')
})

it('locks a clean editor before navigation and releases it if navigation throws', async () => {
  const reload = vi.fn(() => {
    expect(editor.getState().busy).toBe('update')
    expect(editor.getState().replace(fixture())).toBe(false)
  })
  expect(canAutomaticallyReload()).toBe(true)
  expect(await reloadPreservingPresentation(reload)).toBe(true)
  expect(reload).toHaveBeenCalledOnce()
  editor.getState().unlockUpdate()
  await expect(
    reloadPreservingPresentation(() => {
      throw new Error('navigation failed')
    }),
  ).rejects.toThrow('navigation failed')
  expect(editor.getState().busy).toBeNull()
})

it('never saves or reloads a dirty document automatically', async () => {
  editor.getState().replace(fixture())
  const reload = vi.fn()
  expect(canAutomaticallyReload()).toBe(false)
  expect(await reloadPreservingPresentation(reload, false)).toBe(false)
  expect(repository.savePresentation).not.toHaveBeenCalled()
  expect(reload).not.toHaveBeenCalled()
  expect(isPresentationDirty(editor.getState())).toBe(true)
})

it('saves the actual dirty snapshot before a manual reload', async () => {
  const document = fixture()
  editor.getState().replace(document)
  repository.savePresentation.mockResolvedValue({ document, revision: 'a'.repeat(64) })
  const reload = vi.fn(() => expect(isPresentationDirty(editor.getState())).toBe(false))
  expect(await reloadPreservingPresentation(reload)).toBe(true)
  expect(repository.savePresentation).toHaveBeenCalledWith(document, null)
  expect(reload).toHaveBeenCalledOnce()
})

it('retains the draft and exposes a failed save without reloading', async () => {
  editor.getState().replace(fixture())
  repository.savePresentation.mockRejectedValue(new Error('disk full'))
  const reload = vi.fn()
  await expect(reloadPreservingPresentation(reload)).rejects.toThrow('disk full')
  expect(reload).not.toHaveBeenCalled()
  expect(editor.getState().document).toEqual(fixture())
  expect(editor.getState().busy).toBeNull()
  expect(isPresentationDirty(editor.getState())).toBe(true)
})

it('does not discard edits made while the recovery save is pending', async () => {
  const document = fixture()
  editor.getState().replace(document)
  let finish!: (value: unknown) => void
  repository.savePresentation.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const reload = vi.fn()
  const recovery = reloadPreservingPresentation(reload)
  editor.getState().edit((draft) => {
    draft.title = 'Newer edit'
  })
  finish({ document, revision: 'a'.repeat(64) })
  await expect(recovery).rejects.toThrow()
  expect(reload).not.toHaveBeenCalled()
  expect(editor.getState().document!.title).toBe('Newer edit')
  expect(isPresentationDirty(editor.getState())).toBe(true)
  expect(editor.getState().busy).toBeNull()
})

it.each(['load', 'save', 'update', 'synchronizing'] as const)(
  'refuses recovery during %s with a loaded document',
  async (busy) => {
    const document = fixture()
    editor.setState({ document, saved: JSON.stringify(document), busy })
    const reload = vi.fn()
    expect(canAutomaticallyReload()).toBe(false)
    expect(await reloadPreservingPresentation(reload, false)).toBe(false)
    await expect(reloadPreservingPresentation(reload)).rejects.toThrow()
    expect(reload).not.toHaveBeenCalled()
    expect(editor.getState().busy).toBe(busy)
  },
)

it('allows recovery before the initial editor synchronization when there is no document', async () => {
  editor.setState({ busy: 'synchronizing' })
  const reload = vi.fn()
  expect(canAutomaticallyReload()).toBe(true)
  expect(await reloadPreservingPresentation(reload, false)).toBe(true)
  expect(reload).toHaveBeenCalledOnce()
})

it('commits an active field before deciding whether automatic reload is safe', async () => {
  class Input {
    blur() {
      editor.getState().replace(fixture())
    }
  }
  vi.stubGlobal('HTMLElement', Input)
  vi.stubGlobal('document', { activeElement: new Input() })
  const reload = vi.fn()
  expect(await reloadPreservingPresentation(reload, false)).toBe(false)
  expect(reload).not.toHaveBeenCalled()
  expect(isPresentationDirty(editor.getState())).toBe(true)
})

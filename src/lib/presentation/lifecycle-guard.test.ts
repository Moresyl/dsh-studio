import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  applicationLifecycleReply: vi.fn(),
  applicationLifecycleState: vi.fn(),
  onLifecyclePrepare: vi.fn(),
  onLifecycleRelease: vi.fn(),
  onLifecycleBlocked: vi.fn(),
  show: vi.fn(),
  reportFailure: vi.fn(),
  stop: vi.fn(),
}))
vi.mock('@/lib/ipc', () => mocks)
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => mocks }))
vi.mock('@/state/failure', () => ({ reportFailure: mocks.reportFailure }))
import { guardApplicationLifecycle } from './lifecycle-guard'
import { usePresentationEditor } from '@/state/presentation-editor'
import { useLibrary } from '@/state/library'
import { fixture } from './fixtures.test-support'
const prepare = (id: string) => mocks.onLifecyclePrepare.mock.calls[0]![0](id)
const release = (id: string) => mocks.onLifecycleRelease.mock.calls[0]![0](id)
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('document', { activeElement: null })
  for (const listen of [
    mocks.onLifecyclePrepare,
    mocks.onLifecycleRelease,
    mocks.onLifecycleBlocked,
  ])
    listen.mockResolvedValue(mocks.stop)
  mocks.applicationLifecycleReply.mockResolvedValue(undefined)
  mocks.applicationLifecycleState.mockResolvedValue(null)
  mocks.show.mockResolvedValue(undefined)
  usePresentationEditor.setState({ document: null, saved: null, busy: null })
  useLibrary.setState({ editing: false, busy: false })
})
afterEach(() => vi.unstubAllGlobals())

it('refuses an open personal editor or pending save without locking the deck', async () => {
  const stop = await guardApplicationLifecycle()
  useLibrary.setState({ editing: true })
  prepare('editing')
  expect(mocks.applicationLifecycleReply).toHaveBeenCalledWith('editing', false)
  expect(usePresentationEditor.getState().busy).toBeNull()
  release('editing')
  useLibrary.setState({ editing: false, busy: true })
  prepare('saving')
  expect(mocks.applicationLifecycleReply).toHaveBeenCalledWith('saving', false)
  release('saving')
  useLibrary.setState({ busy: false })
  prepare('ready')
  expect(mocks.applicationLifecycleReply).toHaveBeenCalledWith('ready', true)
  stop()
})

it('holds editing until its matching release and coalesces repeated prepare', async () => {
  const stop = await guardApplicationLifecycle()
  prepare('one')
  prepare('two')
  expect(mocks.applicationLifecycleReply).toHaveBeenCalledOnce()
  expect(mocks.applicationLifecycleReply).toHaveBeenCalledWith('one', true)
  expect(usePresentationEditor.getState().busy).toBe('update')
  release('old')
  expect(usePresentationEditor.getState().busy).toBe('update')
  release('one')
  expect(usePresentationEditor.getState().busy).toBeNull()
  prepare('two')
  stop()
  expect(usePresentationEditor.getState().busy).toBeNull()
  expect(mocks.stop).toHaveBeenCalledTimes(3)
})

it('refuses dirty or busy documents without destroying them', async () => {
  await guardApplicationLifecycle()
  const document = fixture()
  usePresentationEditor.setState({ document })
  prepare('one')
  expect(mocks.applicationLifecycleReply).toHaveBeenCalledWith('one', false)
  expect(mocks.show).toHaveBeenCalledOnce()
  release('one')
  expect(usePresentationEditor.getState().document).toEqual(document)
  usePresentationEditor.setState({ saved: JSON.stringify(document), busy: 'save' })
  prepare('two')
  expect(mocks.applicationLifecycleReply).toHaveBeenCalledWith('two', false)
  release('two')
  expect(usePresentationEditor.getState().busy).toBe('save')
})

it('does not release a lock owned by the initiating updater', async () => {
  const stop = await guardApplicationLifecycle()
  usePresentationEditor.setState({ busy: 'update' })
  prepare('one')
  release('one')
  stop()
  expect(usePresentationEditor.getState().busy).toBe('update')
})

it('commits pending input, reports failures and cleans partial subscriptions', async () => {
  class Input {
    blur() {
      usePresentationEditor.setState({ document: fixture() })
    }
  }
  vi.stubGlobal('HTMLElement', Input)
  vi.stubGlobal('document', { activeElement: new Input() })
  await guardApplicationLifecycle()
  prepare('one')
  expect(mocks.applicationLifecycleReply).toHaveBeenCalledWith('one', false)
  release('one')
  vi.stubGlobal('document', { activeElement: null })
  usePresentationEditor.setState({ document: null })
  mocks.applicationLifecycleReply.mockRejectedValueOnce(new Error('late receipt'))
  prepare('two')
  await Promise.resolve()
  await Promise.resolve()
  expect(usePresentationEditor.getState().busy).toBeNull()
  mocks.onLifecycleBlocked.mock.calls[0]![0]()
  expect(mocks.reportFailure).toHaveBeenCalled()
  mocks.onLifecyclePrepare.mockRejectedValueOnce(new Error('listen failed'))
  await expect(guardApplicationLifecycle()).rejects.toThrow('listen failed')
  expect(mocks.stop).toHaveBeenCalledTimes(2)
})

it('keeps a reloaded document locked under an approved native lease without voting twice', async () => {
  usePresentationEditor.setState({ busy: 'synchronizing' })
  mocks.applicationLifecycleState.mockResolvedValue({ id: 'active', awaiting: false })
  const stop = await guardApplicationLifecycle()
  expect(usePresentationEditor.getState().busy).toBe('update')
  expect(mocks.applicationLifecycleReply).not.toHaveBeenCalled()
  expect(usePresentationEditor.getState().replace(fixture(), true)).toBe(false)
  release('active')
  expect(usePresentationEditor.getState().busy).toBeNull()
  stop()
})

it('answers a missed prepare and keeps editing disabled if startup synchronization fails', async () => {
  usePresentationEditor.setState({ busy: 'synchronizing' })
  mocks.applicationLifecycleState.mockResolvedValueOnce({ id: 'missed', awaiting: true })
  const stop = await guardApplicationLifecycle()
  expect(mocks.applicationLifecycleReply).toHaveBeenCalledWith('missed', true)
  stop()
  usePresentationEditor.setState({ busy: 'synchronizing' })
  mocks.applicationLifecycleState.mockRejectedValueOnce(new Error('native unavailable'))
  await expect(guardApplicationLifecycle()).rejects.toThrow('native unavailable')
  expect(usePresentationEditor.getState().busy).toBe('synchronizing')
})

it('does not resurrect a released lease from a late snapshot', async () => {
  usePresentationEditor.setState({ busy: 'synchronizing' })
  let finish!: (value: { id: string; awaiting: boolean }) => void
  mocks.applicationLifecycleState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const started = guardApplicationLifecycle()
  await vi.waitFor(() => expect(mocks.applicationLifecycleState).toHaveBeenCalled())
  release('old')
  finish({ id: 'old', awaiting: true })
  const stop = await started
  expect(mocks.applicationLifecycleReply).not.toHaveBeenCalled()
  expect(usePresentationEditor.getState().busy).toBeNull()
  stop()
})

it('still joins a live snapshot when an unrelated old release arrives during synchronization', async () => {
  usePresentationEditor.setState({ busy: 'synchronizing' })
  let finish!: (value: { id: string; awaiting: boolean }) => void
  mocks.applicationLifecycleState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const started = guardApplicationLifecycle()
  await vi.waitFor(() => expect(mocks.applicationLifecycleState).toHaveBeenCalled())
  release('old')
  finish({ id: 'live', awaiting: false })
  const stop = await started
  expect(usePresentationEditor.getState().busy).toBe('update')
  expect(mocks.applicationLifecycleReply).not.toHaveBeenCalled()
  stop()
})

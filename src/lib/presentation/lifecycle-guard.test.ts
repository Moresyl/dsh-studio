import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  applicationLifecycleReply: vi.fn(),
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
  mocks.show.mockResolvedValue(undefined)
  usePresentationEditor.setState({ document: null, saved: null, busy: null })
})
afterEach(() => vi.unstubAllGlobals())

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

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  label: 'main',
  status: vi.fn(),
  hide: vi.fn(),
  onCloseRequested: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  stop: vi.fn(),
  ask: vi.fn(),
  reportFailure: vi.fn(),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => mocks }))
vi.mock('@/state/dialog', () => ({ ask: mocks.ask }))
vi.mock('@/state/failure', () => ({ reportFailure: mocks.reportFailure }))
vi.mock('@/lib/ipc', () => ({ status: mocks.status }))
import { guardPresentationClose } from './close-guard'
import { usePresentationEditor } from '@/state/presentation-editor'
import { fixture } from './fixtures.test-support'

const callback = () =>
  mocks.onCloseRequested.mock.calls[0]![0] as (event: {
    preventDefault: () => void
  }) => Promise<void>
beforeEach(() => {
  vi.resetAllMocks()
  mocks.label = 'main'
  mocks.status.mockResolvedValue({ phase: 'stopped' })
  mocks.hide.mockResolvedValue(undefined)
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('document', { activeElement: null })
  usePresentationEditor.setState({ document: null, saved: null, revision: null, busy: null })
  mocks.onCloseRequested.mockResolvedValue(mocks.stop)
  mocks.show.mockResolvedValue(undefined)
  mocks.close.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

it('allows a clean window to close and owns listener cleanup', async () => {
  const stop = await guardPresentationClose()
  const preventDefault = vi.fn()
  await callback()({ preventDefault })
  expect(preventDefault).not.toHaveBeenCalled()
  expect(mocks.ask).not.toHaveBeenCalled()
  stop()
  expect(mocks.stop).toHaveBeenCalledOnce()
})

it.each(['starting', 'ready', 'restarting'])(
  'hides a %s main window without destroying or discarding its draft',
  async (phase) => {
    usePresentationEditor.getState().replace(fixture(), true)
    mocks.status.mockResolvedValue({ phase })
    await guardPresentationClose()
    const preventDefault = vi.fn()
    await callback()({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(mocks.hide).toHaveBeenCalledOnce()
    expect(mocks.ask).not.toHaveBeenCalled()
    expect(usePresentationEditor.getState().document).toEqual(fixture())
  },
)

it('task windows still protect dirty drafts while the main Harness is running', async () => {
  mocks.label = 'work-2'
  mocks.status.mockResolvedValue({ phase: 'ready' })
  usePresentationEditor.getState().replace(fixture(), true)
  mocks.ask.mockResolvedValue(false)
  await guardPresentationClose()
  await callback()({ preventDefault: vi.fn() })
  expect(mocks.status).not.toHaveBeenCalled()
  expect(mocks.hide).not.toHaveBeenCalled()
  expect(mocks.ask).toHaveBeenCalledOnce()
})

it('a close that becomes tray hiding does not leave a stale discard approval', async () => {
  usePresentationEditor.getState().replace(fixture(), true)
  mocks.ask.mockResolvedValueOnce(true).mockResolvedValue(false)
  mocks.close.mockImplementation(async () => {
    mocks.status.mockResolvedValue({ phase: 'ready' })
    await callback()({ preventDefault: vi.fn() })
  })
  await guardPresentationClose()
  await callback()({ preventDefault: vi.fn() })
  expect(mocks.hide).toHaveBeenCalledOnce()
  mocks.status.mockResolvedValue({ phase: 'stopped' })
  await callback()({ preventDefault: vi.fn() })
  expect(mocks.ask).toHaveBeenCalledTimes(2)
})

it('native status and hide failures prevent destructive closure and surface the error', async () => {
  await guardPresentationClose()
  const preventDefault = vi.fn()
  mocks.status.mockRejectedValueOnce(new Error('status unavailable'))
  await callback()({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(mocks.reportFailure).toHaveBeenCalledOnce()
  mocks.status.mockResolvedValue({ phase: 'ready' })
  mocks.hide.mockRejectedValueOnce(new Error('hide failed'))
  await callback()({ preventDefault })
  expect(mocks.reportFailure).toHaveBeenCalledTimes(2)
})

it('prevents dirty close and reopens the window before asking; cancellation preserves the draft', async () => {
  usePresentationEditor.getState().replace(fixture(), true)
  mocks.ask.mockResolvedValue(false)
  await guardPresentationClose()
  const preventDefault = vi.fn()
  await callback()({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(mocks.show).toHaveBeenCalledOnce()
  expect(mocks.close).not.toHaveBeenCalled()
  expect(usePresentationEditor.getState().document).toEqual(fixture())
})

it('allows exactly the confirmed close without recursively prompting', async () => {
  usePresentationEditor.getState().replace(fixture(), true)
  mocks.ask.mockResolvedValue(true)
  await guardPresentationClose()
  const innerPrevent = vi.fn()
  mocks.close.mockImplementation(() => callback()({ preventDefault: innerPrevent }))
  await callback()({ preventDefault: vi.fn() })
  expect(mocks.ask).toHaveBeenCalledOnce()
  expect(mocks.close).toHaveBeenCalledOnce()
  expect(innerPrevent).not.toHaveBeenCalled()
})

it('blocks busy close, reports native errors and ignores an answer after unmount', async () => {
  usePresentationEditor.setState({ busy: 'save' })
  const stop = await guardPresentationClose()
  await callback()({ preventDefault: vi.fn() })
  expect(mocks.reportFailure).toHaveBeenCalledOnce()
  expect(mocks.close).not.toHaveBeenCalled()
  usePresentationEditor.setState({ busy: null, document: fixture() })
  mocks.show.mockRejectedValueOnce(new Error('native'))
  await callback()({ preventDefault: vi.fn() })
  expect(mocks.reportFailure).toHaveBeenCalledTimes(2)
  let finish!: (answer: boolean) => void
  mocks.ask.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = callback()({ preventDefault: vi.fn() })
  await Promise.resolve()
  await Promise.resolve()
  await callback()({ preventDefault: vi.fn() })
  expect(mocks.ask).toHaveBeenCalledOnce()
  stop()
  finish(true)
  await pending
  expect(mocks.close).not.toHaveBeenCalled()
})

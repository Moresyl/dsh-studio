import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalExit, TerminalSession } from '@/lib/ipc'
import * as ipc from '@/lib/ipc'
import * as screens from '@/lib/screen'
import { useDialog } from '@/state/dialog'
import { runningCount, subscribeToTerminals, useTerminals } from '@/state/terminals'

// The rules under test are all about what a finished shell does to the tab
// strip, so both sides the store talks to are stubbed: the command surface,
// which only exists inside a real window, and the emulators, which only exist
// inside a real document.
vi.mock('@/lib/ipc', () => ({
  terminalOpen: vi.fn(),
  terminalWrite: vi.fn(),
  terminalResize: vi.fn(),
  terminalClose: vi.fn(),
  terminalList: vi.fn(),
  onTerminalOutput: vi.fn(),
  onTerminalExit: vi.fn(),
}))

vi.mock('@/lib/screen', () => ({
  adopt: vi.fn(),
  clear: vi.fn(),
  discard: vi.fn(),
  dispose: vi.fn(),
  followTheme: vi.fn(() => () => {}),
  reportProblemsTo: vi.fn(),
  retire: vi.fn(),
  write: vi.fn(),
}))

const shell = (id: string): TerminalSession => ({ id, label: 'pwsh', cwd: 'D:\\work' })

/** The exit handler the store registered, which is what these tests fire. */
let ended: (exit: TerminalExit) => void
let unsubscribe: () => void

beforeEach(async () => {
  vi.clearAllMocks()
  useTerminals.setState({ tabs: [], active: null, opening: false, error: null })
  useDialog.setState({ pending: null })

  vi.mocked(ipc.onTerminalOutput).mockResolvedValue(() => {})
  vi.mocked(ipc.onTerminalExit).mockImplementation((handler) => {
    ended = handler
    return Promise.resolve(() => {})
  })
  vi.mocked(ipc.terminalList).mockResolvedValue([shell('t1'), shell('t2'), shell('t3')])

  unsubscribe = await subscribeToTerminals()
  // The store reads the running shells as it subscribes, and that read is what
  // seeds the strip these tests act on.
  await vi.waitFor(() => expect(useTerminals.getState().tabs).toHaveLength(3))
  useTerminals.setState({ active: 't2' })
})

afterEach(() => unsubscribe())

describe('a shell that finishes', () => {
  it('takes its tab with it when it exited cleanly', () => {
    ended({ id: 't2', code: 0 })

    expect(useTerminals.getState().tabs.map((tab) => tab.id)).toEqual(['t1', 't3'])
    expect(screens.dispose).toHaveBeenCalledWith('t2')
  })

  it('leaves the tab behind when it did not, so the last lines can be read', () => {
    ended({ id: 't2', code: 3 })

    const tabs = useTerminals.getState().tabs
    expect(tabs.map((tab) => tab.id)).toEqual(['t1', 't2', 't3'])
    expect(tabs[1]?.exit).toEqual({ code: 3 })
    expect(screens.retire).toHaveBeenCalledWith('t2', 3)
    expect(screens.dispose).not.toHaveBeenCalled()
  })

  it('leaves the tab behind when a signal ended it', () => {
    ended({ id: 't2', code: null })

    expect(useTerminals.getState().tabs[1]?.exit).toEqual({ code: null })
    expect(screens.retire).toHaveBeenCalledWith('t2', null)
  })

  it('hands the selection to the next tab, and to the previous one at the end', () => {
    ended({ id: 't2', code: 0 })
    expect(useTerminals.getState().active).toBe('t3')

    ended({ id: 't3', code: 0 })
    expect(useTerminals.getState().active).toBe('t1')

    ended({ id: 't1', code: 0 })
    expect(useTerminals.getState().active).toBeNull()
  })

  it('leaves the selection alone when it was some other tab that ended', () => {
    ended({ id: 't1', code: 0 })

    expect(useTerminals.getState().active).toBe('t2')
  })
})

describe('a shell the user closed', () => {
  // Killing a shell is itself a bad exit, so without the store remembering that
  // this one was asked for, closing a tab would put it straight back.
  it('goes even though being killed looks like failing', async () => {
    vi.mocked(ipc.terminalClose).mockResolvedValue(undefined)

    await useTerminals.getState().close('t2')
    ended({ id: 't2', code: 1 })

    expect(useTerminals.getState().tabs.map((tab) => tab.id)).toEqual(['t1', 't3'])
    expect(screens.retire).not.toHaveBeenCalled()
  })

  it('is cleared away without a second kill once it has already finished', async () => {
    ended({ id: 't2', code: 1 })
    await useTerminals.getState().close('t2')

    expect(ipc.terminalClose).not.toHaveBeenCalled()
    expect(useTerminals.getState().tabs.map((tab) => tab.id)).toEqual(['t1', 't3'])
    expect(screens.dispose).toHaveBeenCalledWith('t2')
  })

  it('says so and stays on screen when the kill itself fails', async () => {
    vi.mocked(ipc.terminalClose).mockRejectedValue('no such terminal')

    await useTerminals.getState().close('t2')

    expect(useTerminals.getState().tabs).toHaveLength(3)
    expect(useTerminals.getState().error).toBe('no such terminal')
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'no such terminal',
    })
  })

  it('sends only one kill while the first close is still in flight', async () => {
    let finish!: () => void
    vi.mocked(ipc.terminalClose).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )

    const first = useTerminals.getState().close('t2')
    await useTerminals.getState().close('t2')

    expect(ipc.terminalClose).toHaveBeenCalledOnce()
    finish()
    await first
    ended({ id: 't2', code: 1 })
  })
})

describe('opening a shell', () => {
  it('discards an emulator created by a click that lost the opening race', async () => {
    const screen = {} as never
    useTerminals.setState({ opening: true })

    await useTerminals.getState().open(screen, 24, 80)

    expect(ipc.terminalOpen).not.toHaveBeenCalled()
    expect(screens.discard).toHaveBeenCalledWith(screen)
  })

  it('closes the backend shell when binding its emulator fails', async () => {
    const screen = {} as never
    vi.mocked(ipc.terminalOpen).mockResolvedValue(shell('new'))
    vi.mocked(ipc.terminalClose).mockResolvedValue(undefined)
    vi.mocked(screens.adopt).mockImplementation(() => {
      throw new Error('could not bind terminal input')
    })

    await useTerminals.getState().open(screen, 24, 80)

    expect(screens.dispose).toHaveBeenCalledWith('new')
    expect(ipc.terminalClose).toHaveBeenCalledWith('new')
    expect(screens.discard).not.toHaveBeenCalledWith(screen)
    expect(useTerminals.getState().tabs.map((tab) => tab.id)).toEqual(['t1', 't2', 't3'])
    expect(useTerminals.getState().error).toBe('could not bind terminal input')
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'could not bind terminal input',
    })
    expect(useTerminals.getState().opening).toBe(false)
  })
})

describe('reading the strip', () => {
  it('counts only the shells that are still running', () => {
    ended({ id: 't2', code: 9 })

    expect(runningCount(useTerminals.getState().tabs)).toBe(2)
  })

  // A finished tab is not in what Rust reports, and a later read must not take
  // that as evidence the tab never existed.
  it('keeps a finished tab through a resync', async () => {
    ended({ id: 't2', code: 9 })
    vi.mocked(ipc.terminalList).mockResolvedValue([shell('t1'), shell('t3')])

    await useTerminals.getState().sync()

    expect(useTerminals.getState().tabs.map((tab) => tab.id)).toEqual(['t1', 't2', 't3'])
  })

  // The other way round: a tab still marked as running whose shell is not there
  // any more had its exit lost, and there is nothing behind it to keep.
  it('drops a running tab whose shell is no longer there', async () => {
    vi.mocked(ipc.terminalList).mockResolvedValue([shell('t1'), shell('t3')])

    await useTerminals.getState().sync()

    expect(useTerminals.getState().tabs.map((tab) => tab.id)).toEqual(['t1', 't3'])
    expect(useTerminals.getState().active).toBe('t1')
  })
})

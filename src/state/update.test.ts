import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}))

vi.mock('@/lib/updater', () => updater)

import type { Release } from '@/lib/updater'
import { useDialog } from '@/state/dialog'
import { isAnnounceable, useUpdate, watchForUpdates } from '@/state/update'

const release: Release = {
  version: '0.4.0',
  url: 'https://github.com/Moresyl/dsh-studio/releases/tag/v0.4.0',
  notes: 'Fixed a bug',
  published: '2026-08-18T00:00:00Z',
}

const stored = new Map<string, string>()
const localStorage = {
  getItem: vi.fn((key: string) => stored.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
}

beforeEach(() => {
  vi.clearAllMocks()
  stored.clear()
  vi.stubGlobal('window', {
    localStorage,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
  })
  useUpdate.setState({
    release: null,
    checked: false,
    checking: false,
    installing: false,
    progress: null,
    error: null,
    dismissed: null,
  })
  useDialog.setState({ pending: null })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('checking', () => {
  it('stores an available release', async () => {
    updater.checkForUpdate.mockResolvedValue(release)

    await useUpdate.getState().check()

    expect(useUpdate.getState()).toMatchObject({ release, checked: true, checking: false })
  })

  it('represents a successful up-to-date check without a fake release', async () => {
    updater.checkForUpdate.mockResolvedValue(null)

    await useUpdate.getState().check()

    expect(useUpdate.getState()).toMatchObject({ release: null, checked: true, error: null })
  })

  it('deduplicates overlapping checks', async () => {
    let finish!: (value: Release | null) => void
    updater.checkForUpdate.mockReturnValue(new Promise((resolve) => (finish = resolve)))

    const first = useUpdate.getState().check()
    const second = useUpdate.getState().check()
    finish(release)
    await Promise.all([first, second])

    expect(updater.checkForUpdate).toHaveBeenCalledOnce()
  })

  it('does not start a check while an update is installing', async () => {
    useUpdate.setState({ installing: true })

    await useUpdate.getState().check()

    expect(updater.checkForUpdate).not.toHaveBeenCalled()
  })

  it('shows an asked-for failure but keeps a background failure quiet', async () => {
    updater.checkForUpdate.mockRejectedValue(new Error('offline'))

    await useUpdate.getState().check(true)
    expect(useUpdate.getState().error).toBeNull()
    expect(useDialog.getState().pending).toBeNull()

    await useUpdate.getState().check(false)
    expect(useUpdate.getState().error).toBe('offline')
    expect(useDialog.getState().pending).toMatchObject({ kind: 'error', details: 'offline' })
  })
})

describe('dismissal', () => {
  it('remembers exactly the version dismissed', () => {
    useUpdate.setState({ release })

    useUpdate.getState().dismiss()

    expect(useUpdate.getState().dismissed).toBe('0.4.0')
    expect(localStorage.setItem).toHaveBeenCalledWith('dsh-studio:update:dismissed', '0.4.0')
    expect(isAnnounceable(useUpdate.getState())).toBe(false)
  })

  it('announces the next release after an earlier version was dismissed', () => {
    useUpdate.setState({ release, dismissed: '0.3.1' })

    expect(isAnnounceable(useUpdate.getState())).toBe(true)
  })
})

describe('installation', () => {
  it('does not start an install while a check is running', async () => {
    useUpdate.setState({ checking: true })

    await useUpdate.getState().install()

    expect(updater.installUpdate).not.toHaveBeenCalled()
  })

  it('does not ask the updater to install without a reviewed release', async () => {
    await useUpdate.getState().install()

    expect(updater.installUpdate).not.toHaveBeenCalled()
    expect(useUpdate.getState().installing).toBe(false)
  })

  it('forwards progress and clears the busy state after a recoverable failure', async () => {
    useUpdate.setState({ release })
    updater.installUpdate.mockImplementation(async (_version, report) => {
      report({ downloaded: 50, total: 100 })
      throw new Error('signature rejected')
    })

    await useUpdate.getState().install()

    expect(updater.installUpdate).toHaveBeenCalledWith('0.4.0', expect.any(Function))
    expect(useUpdate.getState()).toMatchObject({
      installing: false,
      progress: { downloaded: 50, total: 100 },
      error: 'signature rejected',
    })
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'signature rejected',
    })
  })

  it('clears a stale release when it disappeared before the second check', async () => {
    useUpdate.setState({ release })
    updater.installUpdate.mockResolvedValue(false)

    await useUpdate.getState().install()

    expect(useUpdate.getState()).toMatchObject({ release: null, checked: true })
  })
})

describe('watchForUpdates', () => {
  it('checks after launch and every six hours, then cleans both timers up', async () => {
    vi.useFakeTimers()
    updater.checkForUpdate.mockResolvedValue(null)

    const stop = watchForUpdates()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(updater.checkForUpdate).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000)
    expect(updater.checkForUpdate).toHaveBeenCalledTimes(2)

    stop()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000)
    expect(updater.checkForUpdate).toHaveBeenCalledTimes(2)
  })
})

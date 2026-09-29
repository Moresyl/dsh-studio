import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  cancelUpdate: vi.fn(),
  discardReview: vi.fn(),
  UpdateCancelled: class UpdateCancelled extends Error {},
}))

vi.mock('@/lib/updater', () => updater)

import type { Release } from '@/lib/updater'
import { useDialog } from '@/state/dialog'
import { usePresentationEditor } from '@/state/presentation-editor'
import { fixture } from '@/lib/presentation/fixtures.test-support'
import { isAnnounceable, useUpdate, watchForUpdates } from '@/state/update'

const release: Release = {
  version: '0.4.0',
  currentVersion: '0.3.0',
  reviewId: 'a'.repeat(32),
  fingerprint: 'b'.repeat(64),
  artifact: 'Studio.exe',
  bytes: 100,
  direction: 'newer',
  canInstall: true,
  installBlock: null,
  url: 'https://github.com/Moresyl/dsh-studio/releases/tag/v0.4.0',
  notes: 'Fixed a bug',
  published: '2026-08-18T00:00:00Z',
}

const stored = new Map<string, string>()
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const localStorage = {
  getItem: vi.fn((key: string) => stored.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
}

beforeEach(() => {
  vi.resetAllMocks()
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
    manualChecking: false,
    checkedAt: null,
    installing: false,
    targetRelease: null,
    installation: null,
    cancelling: false,
    progress: null,
    error: null,
    dismissed: null,
  })
  useDialog.setState({ pending: null })
  usePresentationEditor.setState({ document: null, saved: null, busy: null, past: [], future: [] })
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

  it('records a fresh completion even when repeated checks find no update', async () => {
    vi.useFakeTimers()
    updater.checkForUpdate.mockResolvedValue(null)
    vi.setSystemTime(new Date('2026-09-29T01:00:00Z'))
    await useUpdate.getState().check()
    const first = useUpdate.getState().checkedAt
    vi.advanceTimersByTime(1000)
    await useUpdate.getState().check()
    expect(useUpdate.getState().checkedAt).toBe(first! + 1000)
    expect(useUpdate.getState().manualChecking).toBe(false)
  })

  it('makes a manual check observe an already-running quiet failure', async () => {
    let fail!: (cause: Error) => void
    updater.checkForUpdate.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject
      }),
    )

    const quiet = useUpdate.getState().check(true)
    expect(useUpdate.getState().manualChecking).toBe(false)
    const manual = useUpdate.getState().check(false)
    expect(useUpdate.getState().manualChecking).toBe(true)
    fail(new Error('feed unavailable'))
    await Promise.all([quiet, manual])

    expect(updater.checkForUpdate).toHaveBeenCalledOnce()
    expect(useUpdate.getState()).toMatchObject({
      checking: false,
      manualChecking: false,
      error: 'feed unavailable',
    })
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'feed unavailable',
    })
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

  it('clears an older release after a manual refresh fails', async () => {
    updater.checkForUpdate
      .mockResolvedValueOnce(release)
      .mockRejectedValueOnce(new Error('offline'))

    await useUpdate.getState().check()
    await useUpdate.getState().check()

    expect(useUpdate.getState()).toMatchObject({ release: null, checked: false, error: 'offline' })
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
  it('refuses to restart over a dirty or busy presentation', async () => {
    usePresentationEditor.getState().replace(fixture(), true)
    await useUpdate.getState().installVersion(release)
    expect(updater.installUpdate).not.toHaveBeenCalled()
    expect(useUpdate.getState().error).toBeTruthy()
    expect(usePresentationEditor.getState().document).toEqual(fixture())
    usePresentationEditor.setState({ document: null, busy: 'save' })
    await useUpdate.getState().installVersion(release)
    expect(updater.installUpdate).not.toHaveBeenCalled()
    expect(usePresentationEditor.getState().busy).toBe('save')
  })

  it('locks editing during installation and unlocks after failure', async () => {
    const document = fixture()
    usePresentationEditor.setState({ document, saved: JSON.stringify(document) })
    const operation = deferred<boolean>()
    updater.installUpdate.mockReturnValue(operation.promise)
    const pending = useUpdate.getState().installVersion(release)
    expect(usePresentationEditor.getState().busy).toBe('update')
    expect(
      usePresentationEditor.getState().edit((draft) => {
        draft.title = 'Lost edit'
      }),
    ).toBe(false)
    operation.reject(new Error('network unavailable'))
    await pending
    expect(usePresentationEditor.getState().busy).toBeNull()
    expect(usePresentationEditor.getState().document).toEqual(document)
  })

  it('commits pending input before checking for unsaved work', async () => {
    class Input {
      blur() {
        usePresentationEditor.getState().replace(fixture(), true)
      }
    }
    vi.stubGlobal('HTMLElement', Input)
    vi.stubGlobal('document', { activeElement: new Input() })
    await useUpdate.getState().installVersion(release)
    expect(updater.installUpdate).not.toHaveBeenCalled()
    expect(usePresentationEditor.getState().document).toEqual(fixture())
  })

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

    expect(updater.installUpdate).toHaveBeenCalledWith(
      release,
      expect.any(Function),
      'latest',
      expect.any(Function),
    )
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

  it('keeps the selected target visible before its receipt has been renewed', async () => {
    const operation = deferred<boolean>()
    updater.installUpdate.mockReturnValue(operation.promise)
    const selected = { ...release, version: '0.2.0', direction: 'older' as const }
    useUpdate.setState({ release })
    const install = useUpdate.getState().installVersion(selected)
    expect(useUpdate.getState()).toMatchObject({
      installing: true,
      targetRelease: selected,
      installation: null,
    })
    expect(updater.installUpdate).toHaveBeenCalledWith(
      selected,
      expect.any(Function),
      'selected',
      expect.any(Function),
    )
    operation.resolve(true)
    await install
    expect(useUpdate.getState()).toMatchObject({
      release,
      installing: false,
      targetRelease: null,
    })
  })

  it('reports a vanished selected version without clearing the latest release', async () => {
    useUpdate.setState({ release })
    updater.installUpdate.mockResolvedValue(false)
    await useUpdate.getState().installVersion(release)
    expect(useUpdate.getState().release).toEqual(release)
    expect(useUpdate.getState().error).toContain('selected release is no longer available')
  })

  it.each(['checking', 'installing'] as const)(
    'rejects a selected install while %s',
    async (busy) => {
      useUpdate.setState({ [busy]: true })
      await useUpdate.getState().installVersion(release)
      expect(updater.installUpdate).not.toHaveBeenCalled()
    },
  )

  it('cancels during receipt renewal before a native install can start', async () => {
    const renewal = deferred<Release>()
    updater.installUpdate.mockImplementation(async (_release, _report, _target, reviewed) => {
      reviewed(await renewal.promise)
      return true
    })
    const install = useUpdate.getState().installVersion(release)
    await useUpdate.getState().cancelInstall()
    expect(useUpdate.getState().cancelling).toBe(true)
    renewal.resolve(release)
    await install
    expect(updater.cancelUpdate).not.toHaveBeenCalled()
    expect(useUpdate.getState()).toMatchObject({
      installing: false,
      cancelling: false,
      progress: null,
      error: null,
    })
    expect(useDialog.getState().pending).toBeNull()
  })

  it('cancels the renewed receipt once and treats cancellation as a normal result', async () => {
    const operation = deferred<boolean>()
    const fresh = { ...release, reviewId: 'c'.repeat(32) }
    updater.installUpdate.mockImplementation((_release, report, _target, reviewed) => {
      reviewed(fresh)
      report({ downloaded: 10, total: 100, phase: 'downloading' })
      return operation.promise
    })
    updater.cancelUpdate.mockResolvedValue(true)
    const install = useUpdate.getState().installVersion(release)
    await useUpdate.getState().cancelInstall()
    await useUpdate.getState().cancelInstall()
    expect(updater.cancelUpdate).toHaveBeenCalledExactlyOnceWith(fresh)
    operation.reject(new updater.UpdateCancelled())
    await install
    expect(useUpdate.getState()).toMatchObject({
      installing: false,
      installation: null,
      cancelling: false,
      error: null,
      progress: null,
    })
    expect(useDialog.getState().pending).toBeNull()
  })

  it('does not cancel an idle or already committing installation', async () => {
    await useUpdate.getState().cancelInstall()
    useUpdate.setState({
      installing: true,
      installation: release,
      progress: { phase: 'installing', downloaded: 100, total: 100 },
    })
    await useUpdate.getState().cancelInstall()
    expect(updater.cancelUpdate).not.toHaveBeenCalled()
    expect(useUpdate.getState().cancelling).toBe(false)
  })

  it.each([false, new Error('cancel unavailable')])(
    'allows retry when cancellation fails: %s',
    async (result) => {
      useUpdate.setState({ installing: true, installation: release })
      if (result instanceof Error) updater.cancelUpdate.mockRejectedValue(result)
      else updater.cancelUpdate.mockResolvedValue(result)
      await useUpdate.getState().cancelInstall()
      expect(useUpdate.getState().cancelling).toBe(false)
      expect(useUpdate.getState().error).toBe(result instanceof Error ? result.message : null)
    },
  )

  it.each([false, new Error('late cancellation failure')])(
    'ignores a stale cancellation response: %s',
    async (result) => {
      const first = deferred<boolean>()
      const second = deferred<boolean>()
      const cancellation = deferred<boolean>()
      updater.installUpdate
        .mockImplementationOnce((_release, _report, _target, reviewed) => {
          reviewed(release)
          return first.promise
        })
        .mockImplementationOnce((_release, _report, _target, reviewed) => {
          reviewed({ ...release, reviewId: 'd'.repeat(32) })
          return second.promise
        })
      updater.cancelUpdate.mockReturnValueOnce(cancellation.promise).mockResolvedValueOnce(true)
      const firstInstall = useUpdate.getState().installVersion(release)
      const cancel = useUpdate.getState().cancelInstall()
      first.reject(new updater.UpdateCancelled())
      await firstInstall
      const secondInstall = useUpdate.getState().installVersion(release)
      await useUpdate.getState().cancelInstall()
      if (result instanceof Error) cancellation.reject(result)
      else cancellation.resolve(result)
      await cancel
      expect(useUpdate.getState()).toMatchObject({
        installing: true,
        cancelling: true,
        error: null,
      })
      expect(useDialog.getState().pending).toBeNull()
      second.reject(new updater.UpdateCancelled())
      await secondInstall
    },
  )
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

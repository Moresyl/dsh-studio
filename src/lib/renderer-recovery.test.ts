import { beforeEach, describe, expect, it, vi } from 'vitest'

const reportFailure = vi.hoisted(() => vi.fn())
vi.mock('@/state/failure', () => ({ reportFailure }))

import { installPreloadRecovery, needsWorkbench } from '@/lib/renderer-recovery'
import { usePresentationEditor } from '@/state/presentation-editor'
import { fixture } from '@/lib/presentation/fixtures.test-support'

beforeEach(() => {
  vi.clearAllMocks()
  usePresentationEditor.setState({ document: null, saved: null, busy: null })
})

class Target extends EventTarget {
  private stored = new Map<string, string>()
  sessionStorage = {
    getItem: (key: string) => this.stored.get(key) ?? null,
    setItem: (key: string, value: string) => this.stored.set(key, value),
  }
  location = { reload: vi.fn() }
  setTimeout = (handler: () => void) => {
    queueMicrotask(handler)
    return 1
  }
  clearTimeout = vi.fn()
}

describe('renderer surface recovery', () => {
  it('protects edits made while native rearming is pending and explains the blocked reload', async () => {
    const target = new Target()
    installPreloadRecovery(target, () => new Promise(() => {}))
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    usePresentationEditor.getState().replace(fixture())
    await Promise.resolve()
    await Promise.resolve()
    expect(target.location.reload).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledOnce()
    expect(usePresentationEditor.getState().document).toEqual(fixture())
  })

  it('still recovers if native rearming throws synchronously', async () => {
    const target = new Target()
    installPreloadRecovery(target, () => {
      throw new Error('detached')
    })
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    await Promise.resolve()
    expect(target.location.reload).toHaveBeenCalledOnce()
  })

  it('leaves the chunk error available to the boundary when a draft is dirty', async () => {
    usePresentationEditor.getState().replace(fixture())
    const target = new Target()
    const rearm = vi.fn()
    installPreloadRecovery(target, rearm)
    const event = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(event)
    await Promise.resolve()
    expect(event.defaultPrevented).toBe(false)
    expect(rearm).not.toHaveBeenCalled()
    expect(target.location.reload).not.toHaveBeenCalled()
  })

  it('does not navigate after recovery has been disposed', async () => {
    const target = new Target()
    const dispose = installPreloadRecovery(target, async () => {})
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))
    dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(target.location.reload).not.toHaveBeenCalled()
  })

  it('always loads the Workbench when no Harness surface exists', () => {
    expect(needsWorkbench(false, 'compatibility', false)).toBe(true)
    expect(needsWorkbench(false, 'extended', false)).toBe(true)
    expect(needsWorkbench(false, 'advanced', false)).toBe(true)
  })

  it('keeps the upstream-only modes lazy while retaining an opened Workbench', () => {
    expect(needsWorkbench(true, 'compatibility', false)).toBe(false)
    expect(needsWorkbench(true, 'extended', false)).toBe(false)
    expect(needsWorkbench(true, 'advanced', false)).toBe(true)
    expect(needsWorkbench(true, 'compatibility', true)).toBe(true)
  })

  it('rearms and reloads once for repeated split-chunk failures', async () => {
    const target = new Target()
    const rearm = vi.fn().mockResolvedValue(undefined)
    installPreloadRecovery(target, rearm)

    const first = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(first)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(first.defaultPrevented).toBe(true)
    expect(rearm).toHaveBeenCalledTimes(1)
    expect(target.location.reload).toHaveBeenCalledTimes(1)

    const repeated = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(repeated)
    await Promise.resolve()
    expect(repeated.defaultPrevented).toBe(false)
    expect(target.location.reload).toHaveBeenCalledTimes(1)
  })

  it('continues to the visible boundary when reload-loop state is unavailable', async () => {
    const target = new Target()
    target.sessionStorage.setItem = () => {
      throw new Error('storage disabled')
    }
    const rearm = vi.fn().mockResolvedValue(undefined)
    installPreloadRecovery(target, rearm)

    const event = new Event('vite:preloadError', { cancelable: true })
    target.dispatchEvent(event)
    await Promise.resolve()

    expect(event.defaultPrevented).toBe(false)
    expect(rearm).not.toHaveBeenCalled()
    expect(target.location.reload).not.toHaveBeenCalled()
  })
})

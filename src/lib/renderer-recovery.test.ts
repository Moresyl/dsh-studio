import { describe, expect, it, vi } from 'vitest'

import { installPreloadRecovery, needsWorkbench } from '@/lib/renderer-recovery'

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

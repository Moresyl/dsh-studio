import { describe, expect, it, vi } from 'vitest'

import { acquireTogether, ownAsync, type Dispose } from '@/lib/lifecycle'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('native listener lifetimes', () => {
  it('disposes every acquired listener once', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const dispose = await acquireTogether([async () => first, async () => second])

    dispose()
    dispose()

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('rolls back successful siblings before rejecting an acquisition', async () => {
    const acquired = vi.fn()
    const refusal = new Error('event channel unavailable')

    await expect(
      acquireTogether([async () => acquired, async () => await Promise.reject(refusal)]),
    ).rejects.toBe(refusal)
    expect(acquired).toHaveBeenCalledOnce()
  })

  it('tears down a listener that arrives after its owner was unmounted', async () => {
    const pending = deferred<Dispose>()
    const acquired = vi.fn()
    const failed = vi.fn()
    const dispose = ownAsync(pending.promise, failed)

    dispose()
    pending.resolve(acquired)
    await pending.promise
    await Promise.resolve()

    expect(acquired).toHaveBeenCalledOnce()
    expect(failed).not.toHaveBeenCalled()
  })

  it('handles setup and teardown failures without an unhandled promise', async () => {
    const setupFailure = new Error('listen refused')
    const failed = vi.fn()
    ownAsync(Promise.reject(setupFailure), failed)
    await Promise.resolve()
    expect(failed).toHaveBeenCalledWith(setupFailure)

    const teardownFailure = new Error('unlisten refused')
    const dispose = ownAsync(
      Promise.resolve(() => {
        throw teardownFailure
      }),
      failed,
    )
    await Promise.resolve()
    dispose()
    expect(failed).toHaveBeenCalledWith(teardownFailure)
  })
})

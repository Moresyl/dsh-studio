import { describe, expect, it, vi } from 'vitest'

import { crashPayload, installCrashEvidence } from '@/lib/crash'

class Target extends EventTarget {
  location = { href: 'http://127.0.0.1:1420/current' }
}

describe('renderer crash evidence', () => {
  it('bounds ordinary thrown values and preserves Error stacks', () => {
    const error = new Error('failed')
    expect(crashPayload(error, 'app://main')).toMatchObject({
      message: 'failed',
      url: 'app://main',
    })
    expect(crashPayload(error, 'app://main').stack).toContain('Error: failed')
    expect(crashPayload('x'.repeat(40_000), 'u'.repeat(3_000)).message).toHaveLength(32 << 10)
    expect(crashPayload('failure', 'u'.repeat(3_000)).url).toHaveLength(2_048)
  })

  it('reports errors and rejections once, then removes both listeners', async () => {
    const target = new Target()
    const report = vi.fn().mockResolvedValue(undefined)
    const dispose = installCrashEvidence(target as unknown as Window, report)
    const error = new Event('error')
    Object.assign(error, { error: new Error('render failed'), message: '', filename: 'app://main' })
    const rejection = new Event('unhandledrejection')
    Object.assign(rejection, { reason: 'promise failed' })

    target.dispatchEvent(error)
    target.dispatchEvent(error)
    target.dispatchEvent(rejection)
    await Promise.resolve()

    expect(report).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: 'render failed' }))
    expect(report).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: 'promise failed' }))

    dispose()
    target.dispatchEvent(rejection)
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('swallows reporter failures and caps a noisy broken renderer', async () => {
    const target = new Target()
    const report = vi.fn().mockRejectedValue(new Error('native side unavailable'))
    installCrashEvidence(target as unknown as Window, report)
    for (let index = 0; index < 20; index += 1) {
      const event = new Event('unhandledrejection')
      Object.assign(event, { reason: `failure-${index}` })
      target.dispatchEvent(event)
    }
    await Promise.resolve()
    expect(report).toHaveBeenCalledTimes(8)
  })
})

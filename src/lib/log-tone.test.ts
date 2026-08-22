import { describe, expect, it } from 'vitest'

import { logTone } from '@/lib/log-tone'

describe('harness log tone', () => {
  it('does not mistake npm cache traffic on stderr for a failure', () => {
    expect(
      logTone({
        stream: 'stderr',
        line: 'npm http cache zod@https://registry.npmjs.org/zod/-/zod-4.4.3.tgz 0ms',
      }),
    ).toBe('normal')
    expect(logTone({ stream: 'stderr', line: 'added 511 packages in 11s' })).toBe('normal')
  })

  it('keeps warnings distinct from ordinary output', () => {
    expect(
      logTone({
        stream: 'stderr',
        line: 'npm warn deprecated node-domexception@1.0.0: use the native implementation',
      }),
    ).toBe('warning')
  })

  it('keeps unknown stderr and explicit failures red', () => {
    expect(logTone({ stream: 'stderr', line: 'Error: plugin tree failed to load' })).toBe('error')
    expect(logTone({ stream: 'stderr', line: 'an unfamiliar failure form' })).toBe('error')
  })

  it('keeps stdout neutral even when a tool prints the word error there', () => {
    expect(logTone({ stream: 'stdout', line: 'error count: 0' })).toBe('normal')
  })
})

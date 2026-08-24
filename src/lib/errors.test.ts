import { describe as suite, expect, it } from 'vitest'

import { describe } from '@/lib/errors'

suite('describe', () => {
  it('keeps useful backend and Error messages', () => {
    expect(describe('profile is busy')).toBe('profile is busy')
    expect(describe(new Error('terminal could not start'))).toBe('terminal could not start')
  })

  it('does not stringify opaque, empty, or missing rejection values', () => {
    expect(describe({ token: 'secret' })).toBe('Something went wrong.')
    expect(describe('  ')).toBe('Something went wrong.')
    expect(describe(null)).toBe('Something went wrong.')
    expect(describe(null, '无法读取错误详情。')).toBe('无法读取错误详情。')
  })
})

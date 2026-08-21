import { describe, expect, it } from 'vitest'

import { packageName } from '@/state/plugins'

describe('plugin installation identity', () => {
  it('keeps progress attached to the selected package when the install spec is pinned', () => {
    expect(packageName('plain-plugin@1.2.3')).toBe('plain-plugin')
    expect(packageName('@vendor/plugin@0.4.0')).toBe('@vendor/plugin')
    expect(packageName('@vendor/plugin')).toBe('@vendor/plugin')
  })
})

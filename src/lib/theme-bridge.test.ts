import { describe, expect, it } from 'vitest'

import { readPreferenceRequest, themeMessage } from './theme-bridge'

describe('themeMessage', () => {
  it('carries the preference as well as the scheme it resolves to', () => {
    expect(themeMessage('system', true)).toEqual({
      type: 'dsh-studio:theme',
      theme: 'dark',
      preference: 'system',
    })
    expect(themeMessage('light', false)).toEqual({
      type: 'dsh-studio:theme',
      theme: 'light',
      preference: 'light',
    })
  })
})

describe('readPreferenceRequest', () => {
  it.each(['system', 'light', 'dark'] as const)('accepts %s from the page', (preference) => {
    expect(readPreferenceRequest({ type: 'dsh-studio:theme-preference', preference })).toBe(
      preference,
    )
  })

  it('refuses values this window does not have', () => {
    expect(
      readPreferenceRequest({ type: 'dsh-studio:theme-preference', preference: 'sepia' }),
    ).toBeNull()
    expect(readPreferenceRequest({ type: 'dsh-studio:theme-preference' })).toBeNull()
    expect(
      readPreferenceRequest({ type: 'dsh-studio:theme-preference', preference: 1 }),
    ).toBeNull()
  })

  it('ignores every other message, including the ones this window sends itself', () => {
    expect(readPreferenceRequest({ type: 'dsh-studio:theme', theme: 'dark' })).toBeNull()
    expect(readPreferenceRequest({ type: 'dsh-studio:theme-ready' })).toBeNull()
    expect(readPreferenceRequest('dsh-studio:theme-preference')).toBeNull()
    expect(readPreferenceRequest(null)).toBeNull()
    expect(readPreferenceRequest(undefined)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'

import { clipboardAction } from '@/lib/terminal-shortcuts'

const key = (
  value: string,
  overrides: Partial<Parameters<typeof clipboardAction>[0]> = {},
): Parameters<typeof clipboardAction>[0] => ({
  type: 'keydown',
  key: value,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
})

describe('terminal clipboard shortcuts', () => {
  it('uses Command C and Command V on macOS', () => {
    expect(clipboardAction(key('c', { metaKey: true }), true)).toBe('copy')
    expect(clipboardAction(key('V', { metaKey: true }), true)).toBe('paste')
  })

  it('preserves Ctrl C for the shell on Windows and Linux', () => {
    expect(clipboardAction(key('c', { ctrlKey: true }), false)).toBeNull()
    expect(clipboardAction(key('c', { ctrlKey: true, shiftKey: true }), false)).toBe('copy')
    expect(clipboardAction(key('v', { ctrlKey: true, shiftKey: true }), false)).toBe('paste')
  })

  it('rejects extra modifiers and keyup events', () => {
    expect(clipboardAction(key('c', { metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(clipboardAction(key('c', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBeNull()
    expect(clipboardAction({ ...key('c', { metaKey: true }), type: 'keyup' }, true)).toBeNull()
  })
})

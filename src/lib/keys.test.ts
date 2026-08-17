import { describe, expect, it } from 'vitest'

import { readCombination, spellCombination } from '@/lib/keys'

/** A keydown, with nothing held unless the test says so. */
const press = (code: string, held: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', true>> = {}) =>
  readCombination({
    code,
    ctrlKey: held.ctrl ?? false,
    altKey: held.alt ?? false,
    shiftKey: held.shift ?? false,
    metaKey: held.meta ?? false,
  })

describe('readCombination', () => {
  it('writes the modifiers in one fixed order, whatever order they were pressed', () => {
    expect(press('KeyD', { shift: true, ctrl: true })).toBe('Control+Shift+KeyD')
    expect(press('KeyD', { meta: true, alt: true, ctrl: true })).toBe('Control+Alt+Super+KeyD')
  })

  it('reports the physical key, because that is what Rust parses', () => {
    expect(press('Digit1', { alt: true })).toBe('Alt+Digit1')
    expect(press('Space', { ctrl: true })).toBe('Control+Space')
    expect(press('F12', { ctrl: true })).toBe('Control+F12')
  })

  it('waits while only modifiers are down', () => {
    expect(press('ControlLeft', { ctrl: true })).toBeNull()
    expect(press('ShiftRight', { shift: true })).toBeNull()
    expect(press('MetaLeft', { meta: true })).toBeNull()
  })

  /** The rule `startup.rs` enforces, kept here so the recorder never offers a
      combination the save would refuse. */
  it('refuses a combination with nothing to reach past ordinary typing', () => {
    expect(press('KeyD')).toBeNull()
    expect(press('KeyD', { shift: true })).toBeNull()
    expect(press('F5')).toBeNull()

    expect(press('KeyD', { ctrl: true })).toBe('Control+KeyD')
    expect(press('KeyD', { alt: true })).toBe('Alt+KeyD')
    expect(press('KeyD', { meta: true })).toBe('Super+KeyD')
  })
})

describe('spellCombination', () => {
  const spell = (accelerator: string) => spellCombination(accelerator, false)

  it('drops the prefixes a browser adds to letters and digits', () => {
    expect(spell('Control+Shift+KeyD')).toEqual(['Ctrl', 'Shift', 'D'])
    expect(spell('Alt+Digit1')).toEqual(['Alt', '1'])
    expect(spell('Control+NumpadAdd')).toEqual(['Ctrl', 'Num Add'])
  })

  it('writes each platform the way that platform writes it', () => {
    expect(spellCombination('Control+Alt+Shift+Super+KeyD', true)).toEqual([
      '⌃',
      '⌥',
      '⇧',
      '⌘',
      'D',
    ])
    expect(spellCombination('Control+Alt+Shift+Super+KeyD', false)).toEqual([
      'Ctrl',
      'Alt',
      'Shift',
      'Win',
      'D',
    ])
  })

  /** The one token Rust suggests rather than the recorder producing it, so it
      is also the one that would reach a person as a word if it were missed. */
  it('resolves the platform-neutral modifier to a real key', () => {
    expect(spellCombination('CmdOrCtrl+Shift+KeyD', true)).toEqual(['⌘', '⇧', 'D'])
    expect(spellCombination('CommandOrControl+KeyD', false)).toEqual(['Ctrl', 'D'])
  })

  it('prints punctuation as the character it is', () => {
    expect(spell('Control+Backquote')).toEqual(['Ctrl', '`'])
    expect(spell('Control+Alt+Period')).toEqual(['Ctrl', 'Alt', '.'])
  })

  it('leaves a name it does not recognise alone rather than mangling it', () => {
    expect(spell('Control+PageDown')).toEqual(['Ctrl', 'PageDown'])
    expect(spell('Control+F12')).toEqual(['Ctrl', 'F12'])
  })

  it('survives a combination somebody hand-edited into the file', () => {
    expect(spell('')).toEqual([])
    expect(spell('Control+')).toEqual(['Ctrl'])
  })
})

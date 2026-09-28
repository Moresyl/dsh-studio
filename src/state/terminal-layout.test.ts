import { afterEach, describe, expect, it, vi } from 'vitest'

import { decodeTerminalLayout, useTerminalLayout, visibleTerminalIds } from './terminal-layout'

afterEach(() => vi.unstubAllGlobals())

describe('terminal layout', () => {
  it('accepts only supported layouts', () => {
    for (const value of ['columns', 'rows', 'grid'] as const) {
      expect(decodeTerminalLayout(value)).toBe(value)
    }
    for (const value of [null, undefined, {}, [], 4, 'invalid', 'single']) {
      expect(decodeTerminalLayout(value)).toBe('single')
    }
  })

  it('shows the selected terminal in single view', () => {
    expect(visibleTerminalIds(['a', 'b', 'c'], 'b', 'single')).toEqual(['b'])
  })

  it.each(['columns', 'rows'] as const)('keeps %s pairs stable when focus changes', (layout) => {
    expect(visibleTerminalIds(['a', 'b', 'c'], 'a', layout)).toEqual(['a', 'b'])
    expect(visibleTerminalIds(['a', 'b', 'c'], 'b', layout)).toEqual(['a', 'b'])
    expect(visibleTerminalIds(['a', 'b', 'c'], 'c', layout)).toEqual(['c'])
  })

  it('bounds a grid to four live panes and exposes later groups', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(visibleTerminalIds(ids, 'd', 'grid')).toEqual(['a', 'b', 'c', 'd'])
    expect(visibleTerminalIds(ids, 'e', 'grid')).toEqual(['e', 'f'])
    expect(ids).toHaveLength(6)
  })

  it('handles empty, stale, and missing selection without phantom panes', () => {
    expect(visibleTerminalIds([], null, 'grid')).toEqual([])
    expect(visibleTerminalIds(['a'], 'removed', 'columns')).toEqual(['a'])
    expect(visibleTerminalIds(['a'], null, 'single')).toEqual(['a'])
  })

  it('persists only the layout, not process identifiers or commands', () => {
    const setItem = vi.fn()
    vi.stubGlobal('window', { localStorage: { setItem } })
    useTerminalLayout.getState().choose('grid')
    expect(useTerminalLayout.getState().layout).toBe('grid')
    expect(setItem).toHaveBeenCalledExactlyOnceWith('dsh-studio:terminal-layout:v1', 'grid')
  })

  it('keeps the live choice if persistence is unavailable', () => {
    vi.stubGlobal('window', {
      localStorage: {
        setItem: () => {
          throw new Error('storage disabled')
        },
      },
    })
    expect(() => useTerminalLayout.getState().choose('rows')).not.toThrow()
    expect(useTerminalLayout.getState().layout).toBe('rows')
  })
})

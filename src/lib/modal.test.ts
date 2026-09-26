import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent, MouseEvent } from 'react'

import { holdFocus, pressedBackdrop } from './modal'

function control(options: { disabled?: boolean; hidden?: boolean; tabIndex?: number } = {}) {
  return {
    tabIndex: options.tabIndex ?? 0,
    matches: () => options.disabled ?? false,
    closest: () => (options.hidden ? {} : null),
    getClientRects: () => (options.hidden ? [] : [{}]),
    focus: vi.fn(),
  } as unknown as HTMLElement
}

function key(value: string, shiftKey = false) {
  return {
    key: value,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent<HTMLElement>
}

function card(stops: HTMLElement[]) {
  return { querySelectorAll: () => stops, focus: vi.fn() } as unknown as HTMLElement
}

afterEach(() => vi.unstubAllGlobals())

describe('modal keyboard boundaries', () => {
  it('wraps both directions without visiting disabled, hidden or untabbable controls', () => {
    const first = control()
    const last = control()
    const root = card([
      control({ disabled: true }),
      first,
      control({ hidden: true }),
      last,
      control({ tabIndex: -1 }),
    ])
    vi.stubGlobal('document', { activeElement: last })
    const forward = key('Tab')
    holdFocus(root, forward, vi.fn())
    expect(first.focus).toHaveBeenCalledOnce()
    expect(forward.preventDefault).toHaveBeenCalledOnce()
    vi.stubGlobal('document', { activeElement: first })
    holdFocus(root, key('Tab', true), vi.fn())
    expect(last.focus).toHaveBeenCalledOnce()
  })

  it('recovers focus after a loading transition removes the active control', () => {
    const first = control()
    const last = control()
    vi.stubGlobal('document', { activeElement: {} })
    holdFocus(card([first, last]), key('Tab'), vi.fn())
    holdFocus(card([first, last]), key('Tab', true), vi.fn())
    expect(first.focus).toHaveBeenCalledOnce()
    expect(last.focus).toHaveBeenCalledOnce()
  })

  it('retains focus on an empty focusable dialog', () => {
    const root = card([])
    const event = key('Tab')
    holdFocus(root, event, vi.fn())
    expect(root.focus).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('leaves ordinary tab movement alone and isolates Escape from the underlying pane', () => {
    const first = control()
    const middle = control()
    const last = control()
    vi.stubGlobal('document', { activeElement: middle })
    const tab = key('Tab')
    holdFocus(card([first, middle, last]), tab, vi.fn())
    expect(tab.preventDefault).not.toHaveBeenCalled()
    const dismiss = vi.fn()
    const escape = key('Escape')
    holdFocus(null, escape, dismiss)
    expect(dismiss).toHaveBeenCalledOnce()
    expect(escape.stopPropagation).toHaveBeenCalledOnce()
    holdFocus(null, key('ArrowDown'), dismiss)
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('dismisses only when the backdrop itself is pressed', () => {
    const backdrop = {}
    const dismiss = vi.fn()
    pressedBackdrop({ target: {}, currentTarget: backdrop } as MouseEvent<HTMLElement>, dismiss)
    expect(dismiss).not.toHaveBeenCalled()
    pressedBackdrop(
      { target: backdrop, currentTarget: backdrop } as MouseEvent<HTMLElement>,
      dismiss,
    )
    expect(dismiss).toHaveBeenCalledOnce()
  })
})

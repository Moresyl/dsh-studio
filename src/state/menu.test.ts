import { afterEach, describe, expect, it, vi } from 'vitest'

import { useMenu } from './menu'

describe('menu store', () => {
  afterEach(() => useMenu.getState().hide())

  it('keeps selector presentation state until the menu closes', () => {
    const run = vi.fn()
    useMenu.getState().show(10, 20, [{ label: 'Current', selected: true, run }], {
      owner: 'profile',
      minWidth: 128,
    })

    expect(useMenu.getState()).toMatchObject({
      at: { x: 10, y: 20 },
      owner: 'profile',
      minWidth: 128,
    })

    useMenu.getState().hide()

    expect(useMenu.getState()).toMatchObject({
      at: null,
      entries: [],
      owner: null,
      minWidth: null,
    })
  })
})

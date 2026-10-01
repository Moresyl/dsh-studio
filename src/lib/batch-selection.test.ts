import { describe, expect, it } from 'vitest'
import { toggleSelection, visibleSelection } from './batch-selection'

describe('batch session selection', () => {
  it('drops a selection when the view changes and excludes hidden records', () => {
    const selection = { scope: 'search-a', ids: ['one', 'hidden', 'one', 'constructor'] }
    expect(visibleSelection(selection, 'search-b', ['one'])).toEqual([])
    expect(visibleSelection(selection, 'search-a', ['one', 'constructor'])).toEqual([
      'one',
      'constructor',
    ])
  })
  it('caps both whole-view selections and individual additions without mutating the caller', () => {
    const ids = Array.from({ length: 501 }, (_, index) => String(index))
    expect(visibleSelection({ scope: 'all', ids }, 'all', ids)).toHaveLength(500)
    expect(toggleSelection(ids.slice(0, 500), 'extra')).toHaveLength(500)
    expect(toggleSelection(['one'], 'two')).toEqual(['one', 'two'])
    expect(toggleSelection(['one', 'two'], 'one')).toEqual(['two'])
    expect(ids).toHaveLength(501)
  })
})

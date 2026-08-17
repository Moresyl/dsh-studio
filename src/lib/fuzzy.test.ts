import { describe, expect, it } from 'vitest'

import { fuzzy, segments } from '@/lib/fuzzy'

/** The ranking is only ever used to sort, so that is what the tests assert. */
const better = (query: string, winner: string, loser: string): boolean => {
  const left = fuzzy(query, winner)
  const right = fuzzy(query, loser)
  if (!left || !right) throw new Error(`both must match: ${winner} / ${loser}`)
  return left.score > right.score
}

describe('fuzzy', () => {
  it('matches letters in order with gaps between them', () => {
    expect(fuzzy('spl', 'Stop the plugin')?.at).toEqual([0, 9, 10])
  })

  it('passes over an earlier letter when a later one lines up with a word', () => {
    // The `p` of "Stop" comes first, but taking it strands the `l` away from
    // the word the user was plainly aiming at.
    expect(fuzzy('pl', 'Stop the plugin')?.at).toEqual([9, 10])
  })

  it('still takes the earlier letter when nothing later is worth the distance', () => {
    expect(fuzzy('sess', 'Sessions, and one more session')?.at).toEqual([0, 1, 2, 3])
  })

  it('does not match letters that are out of order', () => {
    expect(fuzzy('lps', 'Stop the plugin')).toBeNull()
  })

  it('ignores case in both directions', () => {
    expect(fuzzy('STOP', 'stop the harness')).not.toBeNull()
    expect(fuzzy('stop', 'STOP THE HARNESS')).not.toBeNull()
  })

  it('treats a space in the query as a gap rather than a letter to find', () => {
    expect(fuzzy('st ha', 'Start the harness')).not.toBeNull()
  })

  it('matches an empty query against anything, including nothing', () => {
    expect(fuzzy('', 'whatever')).toEqual({ score: 0, at: [] })
    expect(fuzzy('', '')).toEqual({ score: 0, at: [] })
  })

  it('has nothing to match when the text is empty', () => {
    expect(fuzzy('a', '')).toBeNull()
  })

  it('prefers initials over the same letters buried mid-word', () => {
    expect(better('ph', 'Pause harness', 'Graph history')).toBe(true)
  })

  it('prefers an unbroken run over scattered letters', () => {
    expect(better('plug', 'Plugins', 'Please look under g')).toBe(true)
  })

  it('prefers a match that starts at the front', () => {
    expect(better('term', 'Terminal', 'Open a terminal in this window')).toBe(true)
  })

  it('finds a camelCase hump as the start of a word', () => {
    expect(better('cw', 'cacheWrite', 'ccccccccw')).toBe(true)
  })

  it('works on Chinese, where there are no word breaks to find', () => {
    expect(fuzzy('会话', '跳到会话')?.at).toEqual([2, 3])
    expect(fuzzy('会话', '话会')).toBeNull()
  })
})

describe('segments', () => {
  it('runs matched and unmatched stretches together', () => {
    expect(segments('Plugins', [0, 1, 2])).toEqual([
      { text: 'Plu', hit: true },
      { text: 'gins', hit: false },
    ])
  })

  it('leaves text whole when nothing matched', () => {
    expect(segments('Plugins', [])).toEqual([{ text: 'Plugins', hit: false }])
  })

  it('has no segments for no text', () => {
    expect(segments('', [])).toEqual([])
  })

  it('splits a hit in the middle into three', () => {
    expect(segments('abc', [1])).toEqual([
      { text: 'a', hit: false },
      { text: 'b', hit: true },
      { text: 'c', hit: false },
    ])
  })
})

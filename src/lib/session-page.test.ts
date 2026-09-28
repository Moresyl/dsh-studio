import { describe, expect, it } from 'vitest'

import { SESSION_PAGE_SIZE, sessionPage } from '@/lib/session-page'

const lines = Array.from({ length: 4000 }, (_, index) => ({ seq: index * 3 + 7 }))

describe('bounded session reading', () => {
  it('opens at the beginning and keeps every source row reachable exactly once', () => {
    expect(sessionPage(lines, null, null)).toEqual({ page: 0, pages: 34, start: 0, end: 120 })
    const visited: number[] = []
    for (let page = 0; page < 34; page++) {
      const { start, end } = sessionPage(lines, page, null)
      expect(end - start).toBeLessThanOrEqual(SESSION_PAGE_SIZE)
      visited.push(...lines.slice(start, end).map((line) => line.seq))
    }
    expect(visited).toEqual(lines.map((line) => line.seq))
  })

  it.each([0, 119, 120, 121, 3999])(
    'lands on search hit %i with sparse sequence numbers',
    (index) => {
      const result = sessionPage(lines, null, lines[index]!.seq)
      expect(result.start).toBeLessThanOrEqual(index)
      expect(result.end).toBeGreaterThan(index)
    },
  )

  it('allows navigating away from a hit, and recovers from a missing hit', () => {
    expect(sessionPage(lines, 0, lines[3999]!.seq).page).toBe(0)
    expect(sessionPage(lines, null, -1).page).toBe(0)
  })

  it.each([-5, NaN, Infinity, -Infinity])('clamps invalid page %s', (page) => {
    expect(sessionPage(lines, page, null).page).toBe(0)
  })

  it('handles empty, exact-boundary, fractional and stale page requests', () => {
    expect(sessionPage([], 9, 100)).toEqual({ page: 0, pages: 1, start: 0, end: 0 })
    expect(sessionPage(lines.slice(0, 120), 1, null).page).toBe(0)
    expect(sessionPage(lines, 1.9, null).page).toBe(1)
    expect(sessionPage(lines, 500, null)).toEqual({ page: 33, pages: 34, start: 3960, end: 4000 })
  })
})

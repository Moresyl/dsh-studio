import { describe, expect, it } from 'vitest'
import { previewLines, stepFolder, visitFolder } from '@/lib/file-navigation'

describe('file browser history', () => {
  it('supports back/forward and drops the old forward branch on a new visit', () => {
    const start = { paths: [''], cursor: 0 }
    const second = visitFolder(start, 'src')
    const third = visitFolder(second, 'src/lib')
    expect(stepFolder(third, -1)).toEqual({ paths: ['', 'src', 'src/lib'], cursor: 1 })
    expect(stepFolder(second, 1)).toBe(second)
    expect(stepFolder(start, -1)).toBe(start)
    expect(visitFolder(stepFolder(third, -1), 'assets')).toEqual({
      paths: ['', 'src', 'assets'],
      cursor: 2,
    })
    expect(stepFolder(stepFolder(third, -1), 1)).toEqual(third)
    expect(visitFolder(third, 'src/lib')).toBe(third)
  })

  it('bounds long navigation sessions while keeping the current folder', () => {
    let history = { paths: [''], cursor: 0 }
    for (let n = 0; n < 100; n++) history = visitFolder(history, String(n))
    expect(history.paths).toHaveLength(50)
    expect(history.paths[history.cursor]).toBe('99')
  })

  it('preserves empty lines, CRLF, unicode and literal markup for text previews', () => {
    expect(previewLines('')).toEqual([''])
    expect(previewLines('第一行\r\n\r\n<script>\n')).toEqual(['第一行', '', '<script>', ''])
    expect(previewLines('a\n'.repeat(10000))).toHaveLength(5000)
  })
})

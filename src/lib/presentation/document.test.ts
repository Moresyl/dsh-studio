import { describe, expect, it } from 'vitest'
import {
  parsePresentation,
  presentationSize,
  PresentationError,
  type PresentationDocument,
} from './document'
import { fixture } from './fixtures.test-support'

describe('presentation source boundary', () => {
  it('round-trips editable elements without sharing caller references', () => {
    const source = fixture()
    const parsed = parsePresentation(source)
    expect(parsed).toEqual(source)
    expect(parsed).not.toBe(source)
    parsed.slides[0]!.elements[0]!.x = 99
    expect(source.slides[0]!.elements[0]!.x).toBe(40)
    expect(presentationSize('wide')).toEqual({ width: 1280, height: 720 })
    expect(presentationSize('standard')).toEqual({ width: 960, height: 720 })
  })

  it('supports an empty slide and zero-height native line without inventing content', () => {
    const source = fixture()
    source.slides[0]!.elements = [
      {
        id: 'line',
        kind: 'shape',
        x: 0,
        y: 0,
        width: 500,
        height: 0,
        rotation: 90,
        shape: 'line',
        fill: '000000',
        line: '000000',
        lineWidth: 1,
        opacity: 1,
      },
    ]
    expect(parsePresentation(source)).toEqual(source)
    source.slides[0]!.elements = []
    source.aspect = 'standard'
    expect(parsePresentation(source).slides[0]!.elements).toEqual([])
  })

  const cases: [string, (string | number)[], unknown][] = [
    ['unknown version', ['version'], 2],
    ['unknown field', ['script'], 'private content'],
    ['unknown format', ['format'], 'other'],
    ['empty title', ['title'], '  '],
    ['invalid identifier', ['id'], '../escape'],
    ['no slides', ['slides'], []],
    ['non-object slide', ['slides'], [null]],
    ['duplicate slides', ['slides'], [fixture().slides[0], fixture().slides[0]]],
    [
      'duplicate elements',
      ['slides', 0, 'elements'],
      [fixture().slides[0]!.elements[0], fixture().slides[0]!.elements[0]],
    ],
    ['non-object element', ['slides', 0, 'elements'], [null]],
    ['unsupported element', ['slides', 0, 'elements', 0, 'kind'], 'html'],
    ['out-of-bounds object', ['slides', 0, 'elements', 0, 'width'], 2000],
    ['non-finite position', ['slides', 0, 'elements', 0, 'x'], Infinity],
    ['negative position', ['slides', 0, 'elements', 0, 'y'], -1],
    ['excessive font', ['slides', 0, 'elements', 0, 'fontSize'], 999],
    ['invalid color', ['slides', 0, 'elements', 0, 'color'], 'url(secret)'],
    ['unsupported alignment', ['slides', 0, 'elements', 0, 'align'], 'start'],
    ['invalid boolean', ['slides', 0, 'elements', 0, 'bold'], 'true'],
    ['XML control', ['slides', 0, 'elements', 0, 'text'], 'a\u0001b'],
    ['unpaired surrogate', ['slides', 0, 'elements', 0, 'text'], '\ud800'],
    [
      'empty frame',
      ['slides', 0, 'elements', 1],
      { ...fixture().slides[0]!.elements[1], shape: 'line', width: 0, height: 0 },
    ],
    ['unsupported shape', ['slides', 0, 'elements', 1, 'shape'], 'custom-svg'],
    ['invalid opacity', ['slides', 0, 'elements', 1, 'opacity'], 2],
    ['rotated table', ['slides', 0, 'elements', 2, 'rotation'], 1],
    ['unequal rows', ['slides', 0, 'elements', 2, 'rows'], [['a', 'b'], ['c']]],
    ['non-string table cell', ['slides', 0, 'elements', 2, 'rows', 1, 0], 12],
    ['rotated chart', ['slides', 0, 'elements', 3, 'rotation'], 1],
    ['unequal chart series', ['slides', 0, 'elements', 3, 'series', 0, 'values'], [12]],
    ['negative pie values', ['slides', 0, 'elements', 3, 'chart'], 'pie'],
    [
      'empty pie total',
      ['slides', 0, 'elements', 3],
      {
        ...fixture().slides[0]!.elements[3],
        chart: 'pie',
        series: [{ name: 'Empty', values: [0, 0] }],
      },
    ],
  ]
  it.each(cases)('rejects %s before changing caller data', (_, path, value) => {
    const source = fixture()
    let target: unknown = source
    for (const key of path.slice(0, -1)) target = Reflect.get(target as object, key)
    Reflect.set(target as object, path.at(-1)!, value)
    const before = JSON.stringify(source)
    expect(() => parsePresentation(source)).toThrow(PresentationError)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('bounds encoded bytes, slides, per-slide elements and total elements', () => {
    expect(() => parsePresentation({ ...fixture(), title: '中'.repeat(800_000) })).toThrow(
      'size limit',
    )
    const source = fixture()
    const page = source.slides[0]!
    source.slides = Array.from({ length: 101 }, (_, index) => ({ ...page, id: `page-${index}` }))
    expect(() => parsePresentation(source)).toThrow('item count')
    source.slides = [page]
    page.elements = Array.from({ length: 201 }, (_, index) => ({
      ...page.elements[0]!,
      id: `text-${index}`,
    }))
    expect(() => parsePresentation(source)).toThrow('item count')
    page.elements = page.elements.slice(0, 200)
    source.slides = Array.from({ length: 11 }, (_, index) => ({ ...page, id: `page-${index}` }))
    expect(() => parsePresentation(source)).toThrow('element count')
  })

  it('handles invalid roots and cycles without echoing private input', () => {
    for (const value of [null, [], 1, undefined, 'private content'])
      expect(() => parsePresentation(value)).toThrow(PresentationError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => parsePresentation(cyclic)).toThrow('serializable')
    const source = fixture() as PresentationDocument & { secret?: string }
    source.secret = 'private content'
    try {
      parsePresentation(source)
    } catch (cause) {
      expect(cause).toBeInstanceOf(PresentationError)
      expect((cause as Error).message).not.toContain(source.secret)
    }
  })
})

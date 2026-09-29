import { expect, it } from 'vitest'
import { createTemplate, TEMPLATE_KINDS, type TemplateKind } from './templates'
import { parsePresentation } from './document'
import JSZip from 'jszip'
import { exportPresentation } from './export'

const copy = {
  title: '季度报告',
  subtitle: '替换示例内容',
  overview: '概览',
  details: '详情',
  next: '下一步',
  body: '填写内容',
  series: '示例数据',
}

it.each(TEMPLATE_KINDS)('creates a valid independently editable %s document', (kind) => {
  const first = createTemplate(kind, copy)
  const second = createTemplate(kind, copy)
  expect(parsePresentation(first)).toEqual(first)
  expect(first.slides).toHaveLength(kind === 'blank' ? 1 : 3)
  expect(first.id).not.toBe(second.id)
  const identities = (doc: typeof first) =>
    doc.slides.flatMap((page) => [page.id, ...page.elements.map((element) => element.id)])
  expect(identities(first).some((id) => identities(second).includes(id))).toBe(false)
  first.slides[0]!.title = 'Changed'
  expect(second.slides[0]!.title).toBe(copy.title)
  expect(second.title).toBe(copy.title)
})

it('keeps report data editable and refuses unsupported templates or invalid copy', () => {
  const report = createTemplate('report', copy)
  expect(report.slides[1]!.elements.some((element) => element.kind === 'chart')).toBe(true)
  expect(report.slides[2]!.elements.some((element) => element.kind === 'table')).toBe(true)
  expect(() => createTemplate('unknown' as TemplateKind, copy)).toThrow('Unknown')
  expect(() => createTemplate('brief', { ...copy, title: '' })).toThrow()
  expect(() => createTemplate('report', { ...copy, body: '\u0000' })).toThrow()
})

it.each(['brief', 'report'] as const)(
  'exports all %s template pages as editable Office objects',
  async (kind) => {
    const source = createTemplate(kind, copy)
    const archive = await JSZip.loadAsync(await exportPresentation(source))
    const slides = Object.keys(archive.files).filter((path) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(path),
    )
    expect(slides).toHaveLength(3)
    expect(await archive.file(slides[0]!)!.async('string')).toContain(copy.title)
    if (kind === 'report') {
      expect(await archive.file('ppt/slides/slide2.xml')!.async('string')).toContain('<c:chart')
      expect(await archive.file('ppt/slides/slide3.xml')!.async('string')).toContain('<a:tbl>')
    }
    for (const path of slides)
      expect(await archive.file(path)!.async('string')).not.toContain('<p:pic>')
  },
)

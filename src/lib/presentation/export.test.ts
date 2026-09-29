import { afterEach, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { exportPresentation } from './export'
import { fixture } from './fixtures.test-support'

afterEach(() => vi.restoreAllMocks())

async function chartAt(archive: JSZip, page: number) {
  const slide = await archive.file(`ppt/slides/slide${page}.xml`)!.async('string')
  const id = /<c:chart[^>]*r:id="([^"]+)"/.exec(slide)![1]!
  const relationships = await archive
    .file(`ppt/slides/_rels/slide${page}.xml.rels`)!
    .async('string')
  const relationship = [...relationships.matchAll(/<Relationship\b[^>]*\/>/g)].find(([row]) =>
    row.includes(`Id="${id}"`),
  )![0]
  const target = /Target="([^"]+)"/.exec(relationship)![1]!
  const resolved = new URL(target, `https://package.invalid/ppt/slides/slide${page}.xml`)
  expect(resolved.origin).toBe('https://package.invalid')
  expect(resolved.pathname).toMatch(/^\/ppt\/charts\/chart\d+\.xml$/)
  return archive.file(resolved.pathname.slice(1))!.async('string')
}

it('exports editable Office text, shapes, tables, charts and notes without external relationships', async () => {
  const source = fixture()
  const before = structuredClone(source)
  const bytes = await exportPresentation(source)
  expect(source).toEqual(before)
  const archive = await JSZip.loadAsync(bytes)
  const slide = await archive.file('ppt/slides/slide1.xml')!.async('string')
  expect(slide).toContain('Editable 中文 &amp; &lt;text&gt; 😀')
  expect(slide).toContain('Second paragraph')
  expect(slide).toContain('typeface="Microsoft YaHei"')
  expect(slide).toContain('<a:prstGeom prst="roundRect">')
  expect(slide).toContain('<a:tbl>')
  expect(slide).toContain('<c:chart')
  expect(slide).not.toContain('<p:pic>')
  const chart = await chartAt(archive, 1)
  expect(chart).toContain('<c:barChart>')
  expect(chart).toContain('一季度')
  expect(chart).toContain('<c:v>-3.5</c:v>')
  const workbookPath = Object.keys(archive.files).find((path) => path.endsWith('.xlsx'))!
  const workbook = await JSZip.loadAsync(await archive.file(workbookPath)!.async('uint8array'))
  expect(Object.keys(workbook.files).some((path) => path.startsWith('xl/worksheets/'))).toBe(true)
  const notes = await archive.file('ppt/notesSlides/notesSlide1.xml')!.async('string')
  expect(notes).toContain('Second line 中文')
  for (const [path, file] of Object.entries(archive.files)) {
    if (path.endsWith('.rels'))
      expect(await file.async('string')).not.toContain('TargetMode="External"')
  }
})

it('keeps page order and aspect while exporting native line and pie charts', async () => {
  const source = fixture()
  const page = source.slides[0]!
  page.elements = page.elements.filter((element) => element.kind === 'chart')
  source.aspect = 'standard'
  const chart = page.elements[0]!
  if (chart.kind !== 'chart') throw Error('fixture')
  Object.assign(chart, { x: 40, width: 800, chart: 'line' })
  const second = structuredClone(page)
  second.id = 'slide-2'
  const pie = second.elements[0]!
  if (pie.kind !== 'chart') throw Error('fixture')
  pie.chart = 'pie'
  pie.series[0]!.values = [12, 3.5]
  source.slides.push(second)
  const archive = await JSZip.loadAsync(await exportPresentation(source))
  expect(await archive.file('ppt/presentation.xml')!.async('string')).toContain(
    'cx="9144000" cy="6858000"',
  )
  expect(await chartAt(archive, 1)).toContain('<c:lineChart>')
  expect(await chartAt(archive, 2)).toContain('<c:pieChart>')
  expect(archive.file('ppt/slides/slide2.xml')).not.toBeNull()
})

it('rejects invalid source rather than producing a partial file', async () => {
  await expect(exportPresentation({ ...fixture(), version: 9 })).rejects.toThrow('document.version')
})

it('escapes every font attribute boundary without changing source text', async () => {
  const source = fixture()
  const font = `A&B <C> "D" 'E'\t\n\r`
  for (const element of source.slides[0]!.elements)
    if (element.kind === 'text' || element.kind === 'table') element.fontFace = font
  const archive = await JSZip.loadAsync(await exportPresentation(source))
  const slide = await archive.file('ppt/slides/slide1.xml')!.async('string')
  expect(slide).toContain('typeface="A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;&#9;&#10;&#13;"')
  expect(slide).not.toContain('<C>')
})

it('reports bounded output and opaque compiler failures', async () => {
  const write = vi.spyOn(PptxGenJS.prototype, 'write')
  write.mockResolvedValueOnce(new Uint8Array(20 * 1024 * 1024 + 1))
  await expect(exportPresentation(fixture())).rejects.toThrow('output size limit')
  write.mockRejectedValueOnce(new Error('private compiler detail'))
  await expect(exportPresentation(fixture())).rejects.toThrow('could not create the presentation')
})

it('also hides synchronous compiler failures before serialization', async () => {
  vi.spyOn(PptxGenJS.prototype, 'addSlide').mockImplementationOnce(() => {
    throw new Error('private compiler path')
  })
  await expect(exportPresentation(fixture())).rejects.toThrow(
    'export: could not create the presentation',
  )
})

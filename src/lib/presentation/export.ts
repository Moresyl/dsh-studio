import PptxGenJS from 'pptxgenjs'
import { parsePresentation, presentationSize, PresentationError, type Frame } from './document'

const position = (element: Frame) => ({
  x: element.x / 96,
  y: element.y / 96,
  w: element.width / 96,
  h: element.height / 96,
  objectName: element.id,
})

// The exporter interpolates font names into OOXML attributes without escaping.
const fontAttribute = (font: string) =>
  font
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\t', '&#9;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;')

/** Compile data to native Office objects. No HTML, executable source or remote resource loading. */
export async function exportPresentation(source: unknown): Promise<Uint8Array> {
  const document = parsePresentation(source)
  try {
    return await compilePresentation(document)
  } catch (cause) {
    if (cause instanceof PresentationError) throw cause
    throw new PresentationError('export', 'could not create the presentation')
  }
}

async function compilePresentation(
  document: ReturnType<typeof parsePresentation>,
): Promise<Uint8Array> {
  const size = presentationSize(document.aspect)
  const output = new PptxGenJS()
  output.defineLayout({ name: 'STUDIO', width: size.width / 96, height: size.height / 96 })
  output.layout = 'STUDIO'
  output.author = 'DSH Studio'
  output.subject = 'Editable presentation'
  output.title = document.title
  output.company = ''
  for (const page of document.slides) {
    const slide = output.addSlide()
    slide.background = { color: page.background }
    if (page.notes) slide.addNotes(page.notes)
    for (const element of page.elements) {
      const frame = position(element)
      if (element.kind === 'text') {
        slide.addText(element.text, {
          ...frame,
          fontFace: fontAttribute(element.fontFace),
          fontSize: element.fontSize,
          color: element.color,
          bold: element.bold,
          italic: element.italic,
          align: element.align,
          rotate: element.rotation,
          margin: 0,
          valign: 'top',
          breakLine: false,
        })
      } else if (element.kind === 'shape') {
        slide.addShape(output.ShapeType[element.shape], {
          ...frame,
          rotate: element.rotation,
          fill: { color: element.fill, transparency: Math.round((1 - element.opacity) * 100) },
          line: {
            color: element.line,
            width: element.lineWidth,
            transparency: element.lineWidth === 0 ? 100 : 0,
          },
        })
      } else if (element.kind === 'table') {
        slide.addTable(
          element.rows.map((row) => row.map((text) => ({ text }))),
          {
            ...frame,
            rowH: frame.h / element.rows.length,
            colW: frame.w / element.rows[0]!.length,
            autoPage: false,
            fontFace: fontAttribute(element.fontFace),
            fontSize: element.fontSize,
            color: element.color,
            fill: { color: element.fill },
            border: { type: 'solid', color: element.border, pt: 0.5 },
            margin: 4,
          },
        )
      } else {
        slide.addChart(
          output.ChartType[element.chart],
          element.series.map((series) => ({
            name: series.name,
            labels: [...element.categories],
            values: [...series.values],
          })),
          {
            ...frame,
            chartColors: [...element.colors],
            showLegend: element.showLegend,
            legendPos: 'b',
            showTitle: false,
            showValue: false,
            barDir: 'col',
          },
        )
      }
    }
  }
  const bytes = await output.write({ outputType: 'uint8array', compression: true })
  if (!(bytes instanceof Uint8Array) || bytes.length > 20 * 1024 * 1024)
    throw new PresentationError('export', 'output size limit exceeded')
  return bytes
}

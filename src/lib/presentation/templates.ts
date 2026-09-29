import { blankSlide, newPresentation } from './authoring'
import { parsePresentation, type PresentationSlide, type TextElement } from './document'

export const TEMPLATE_KINDS = ['blank', 'brief', 'report'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]
export interface TemplateCopy {
  title: string
  subtitle: string
  overview: string
  details: string
  next: string
  body: string
  series: string
}

/** Each invocation creates an independent editable source, never a shared template draft. */
export function createTemplate(kind: TemplateKind, copy: TemplateCopy) {
  if (!TEMPLATE_KINDS.includes(kind)) throw new Error('Unknown presentation template')
  const document = newPresentation(copy.title)
  if (kind === 'blank') return document
  const dark = kind === 'brief'
  const ink = dark ? 'F5F5F5' : '182A38'
  const accent = dark ? '83D4C4' : '2863A0'
  const background = dark ? '182827' : 'F8FAFC'
  const text = (
    value: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontSize: number,
    color = ink,
  ): TextElement => ({
    id: crypto.randomUUID(),
    kind: 'text',
    text: value,
    x,
    y,
    width,
    height,
    rotation: 0,
    fontFace: 'Arial',
    fontSize,
    color,
    bold: fontSize >= 32,
    italic: false,
    align: 'left',
  })
  const page = (title: string): PresentationSlide => ({ ...blankSlide(title), background })
  const cover = page(copy.title)
  cover.elements = [
    {
      id: crypto.randomUUID(),
      kind: 'shape',
      x: 80,
      y: 132,
      width: 72,
      height: 8,
      rotation: 0,
      shape: 'rect',
      fill: accent,
      line: accent,
      lineWidth: 0,
      opacity: 1,
    },
    text(copy.title, 80, 208, 1120, 180, 48),
    text(copy.subtitle, 80, 440, 1000, 100, 22, accent),
  ]
  const overview = page(copy.overview)
  overview.elements = [text(copy.overview, 80, 60, 1120, 100, 36)]
  if (kind === 'brief') {
    for (let index = 0; index < 3; index++) {
      const x = 80 + index * 380
      overview.elements.push(
        text(`0${index + 1}`, x, 230, 300, 80, 42, accent),
        text(copy.body, x, 350, 330, 220, 22),
      )
    }
  } else {
    overview.elements.push(
      {
        id: crypto.randomUUID(),
        kind: 'chart',
        x: 80,
        y: 210,
        width: 720,
        height: 400,
        rotation: 0,
        chart: 'bar',
        categories: ['A', 'B', 'C'],
        series: [{ name: copy.series, values: [24, 38, 52] }],
        colors: [accent],
        showLegend: true,
      },
      text(copy.body, 880, 230, 320, 340, 22),
    )
  }
  const closing = page(copy.next)
  closing.elements = [text(copy.next, 80, 60, 1120, 100, 36)]
  if (kind === 'report') {
    closing.elements.push({
      id: crypto.randomUUID(),
      kind: 'table',
      x: 80,
      y: 220,
      width: 1120,
      height: 350,
      rotation: 0,
      rows: [
        [copy.overview, copy.details],
        ['A', copy.body],
        ['B', copy.body],
      ],
      fontFace: 'Arial',
      fontSize: 22,
      color: ink,
      fill: 'FFFFFF',
      border: 'CBD5E1',
    })
  } else {
    closing.elements.push(text(copy.body, 80, 250, 1040, 250, 28, accent))
  }
  document.slides = [cover, overview, closing]
  return parsePresentation(document)
}

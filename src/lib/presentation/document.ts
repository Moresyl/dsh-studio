/** Versioned, data-only presentation source. Coordinates are logical 96-DPI pixels. */
export interface Frame {
  id: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export interface TextElement extends Frame {
  kind: 'text'
  text: string
  fontFace: string
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
}

export interface ShapeElement extends Frame {
  kind: 'shape'
  shape: 'rect' | 'roundRect' | 'ellipse' | 'line'
  fill: string
  line: string
  lineWidth: number
  opacity: number
}

export interface TableElement extends Frame {
  kind: 'table'
  rows: string[][]
  fontFace: string
  fontSize: number
  color: string
  fill: string
  border: string
}

export interface ChartElement extends Frame {
  kind: 'chart'
  chart: 'bar' | 'line' | 'pie'
  categories: string[]
  series: { name: string; values: number[] }[]
  colors: string[]
  showLegend: boolean
}

export type SlideElement = TextElement | ShapeElement | TableElement | ChartElement

export interface PresentationSlide {
  id: string
  title: string
  notes: string
  background: string
  elements: SlideElement[]
}

export interface PresentationDocument {
  format: 'dsh-studio-presentation'
  version: 1
  id: string
  title: string
  aspect: 'wide' | 'standard'
  slides: PresentationSlide[]
}

export class PresentationError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`)
    this.name = 'PresentationError'
  }
}

export const PRESENTATION_LIMIT = 2 * 1024 * 1024
export const PRESENTATION_TITLE_LIMIT = 160
const FRAME_KEYS = ['id', 'kind', 'x', 'y', 'width', 'height', 'rotation']
const XML_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

function reject(path: string, reason: string): never {
  throw new PresentationError(path, reason)
}

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(path, 'expected object')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => !keys.includes(key))) reject(path, 'unsupported field')
  return result
}

function text(
  value: unknown,
  max: number,
  path: string,
  required = false,
): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    reject(path, 'invalid text or text limit exceeded')
  if (XML_CONTROLS.test(value) || LONE_SURROGATE.test(value))
    reject(path, 'invalid text characters')
}

function number(value: unknown, min: number, max: number, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    reject(path, 'number outside supported range')
}

function choice(value: unknown, choices: readonly unknown[], path: string) {
  if (!choices.includes(value)) reject(path, 'unsupported value')
}

function color(value: unknown, path: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{6}$/i.test(value)) reject(path, 'expected RGB color')
}

function list(value: unknown, min: number, max: number, path: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    reject(path, 'item count outside supported range')
}

function identity(value: unknown, seen: Set<string>, path: string) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(value) || seen.has(value))
    reject(path, 'invalid or duplicate identifier')
  seen.add(value)
}

export function presentationSize(aspect: PresentationDocument['aspect']) {
  return { width: aspect === 'wide' ? 1280 : 960, height: 720 }
}

/** Reject unsupported source before editing/export; never silently flatten or drop fields. */
export function parsePresentation(value: unknown): PresentationDocument {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    reject('document', 'expected serializable document')
  }
  if (!serialized || new TextEncoder().encode(serialized).length > PRESENTATION_LIMIT)
    reject('document', 'document size limit exceeded')
  // Detach caller references and remove prototypes before returning an editable document.
  const doc = record(
    JSON.parse(serialized),
    ['format', 'version', 'id', 'title', 'aspect', 'slides'],
    'document',
  )
  choice(doc.format, ['dsh-studio-presentation'], 'document.format')
  choice(doc.version, [1], 'document.version')
  choice(doc.aspect, ['wide', 'standard'], 'document.aspect')
  identity(doc.id, new Set(), 'document.id')
  text(doc.title, PRESENTATION_TITLE_LIMIT, 'document.title', true)
  list(doc.slides, 1, 100, 'document.slides')
  const size = presentationSize(doc.aspect as PresentationDocument['aspect'])
  const slideIds = new Set<string>()
  let elementCount = 0
  for (const [index, value] of doc.slides.entries()) {
    const path = `slides[${index}]`
    const slide = record(value, ['id', 'title', 'notes', 'background', 'elements'], path)
    identity(slide.id, slideIds, `${path}.id`)
    text(slide.title, 160, `${path}.title`)
    text(slide.notes, 20_000, `${path}.notes`)
    color(slide.background, `${path}.background`)
    list(slide.elements, 0, 200, `${path}.elements`)
    elementCount += slide.elements.length
    if (elementCount > 2_000) reject('document', 'element count limit exceeded')
    const ids = new Set<string>()
    slide.elements.forEach((element, index) =>
      validateElement(element, ids, size, `${path}.elements[${index}]`),
    )
  }
  return doc as unknown as PresentationDocument
}

function validateElement(
  value: unknown,
  ids: Set<string>,
  size: { width: number; height: number },
  path: string,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(path, 'expected element')
  const kind = (value as Record<string, unknown>).kind
  const fields =
    kind === 'text'
      ? ['text', 'fontFace', 'fontSize', 'color', 'bold', 'italic', 'align']
      : kind === 'shape'
        ? ['shape', 'fill', 'line', 'lineWidth', 'opacity']
        : kind === 'table'
          ? ['rows', 'fontFace', 'fontSize', 'color', 'fill', 'border']
          : kind === 'chart'
            ? ['chart', 'categories', 'series', 'colors', 'showLegend']
            : reject(`${path}.kind`, 'unsupported element')
  const item = record(value, [...FRAME_KEYS, ...fields], path)
  identity(item.id, ids, `${path}.id`)
  number(item.x, 0, size.width, `${path}.x`)
  number(item.y, 0, size.height, `${path}.y`)
  const minimum = kind === 'shape' && item.shape === 'line' ? 0 : 1
  number(item.width, minimum, size.width - item.x, `${path}.width`)
  number(item.height, minimum, size.height - item.y, `${path}.height`)
  if (item.width + item.height === 0) reject(path, 'empty frame')
  number(item.rotation, 0, 360, `${path}.rotation`)
  if (kind === 'text' || kind === 'table') {
    text(item.fontFace, 80, `${path}.fontFace`, true)
    number(item.fontSize, 6, 144, `${path}.fontSize`)
    color(item.color, `${path}.color`)
  }
  if (kind === 'text') {
    text(item.text, 20_000, `${path}.text`)
    choice(item.bold, [true, false], `${path}.bold`)
    choice(item.italic, [true, false], `${path}.italic`)
    choice(item.align, ['left', 'center', 'right'], `${path}.align`)
  } else if (kind === 'shape') {
    choice(item.shape, ['rect', 'roundRect', 'ellipse', 'line'], `${path}.shape`)
    color(item.fill, `${path}.fill`)
    color(item.line, `${path}.line`)
    number(item.lineWidth, 0, 20, `${path}.lineWidth`)
    number(item.opacity, 0, 1, `${path}.opacity`)
  } else if (kind === 'table') {
    if (item.rotation !== 0) reject(`${path}.rotation`, 'table rotation is not supported')
    color(item.fill, `${path}.fill`)
    color(item.border, `${path}.border`)
    list(item.rows, 1, 40, `${path}.rows`)
    let columns = 0
    item.rows.forEach((row, index) => {
      list(row, 1, 12, `${path}.rows[${index}]`)
      if (index > 0 && row.length !== columns) reject(`${path}.rows`, 'unequal row lengths')
      columns = row.length
      row.forEach((cell, col) => text(cell, 2_000, `${path}.rows[${index}][${col}]`))
    })
  } else {
    if (item.rotation !== 0) reject(`${path}.rotation`, 'chart rotation is not supported')
    choice(item.chart, ['bar', 'line', 'pie'], `${path}.chart`)
    list(item.categories, 1, 100, `${path}.categories`)
    item.categories.forEach((category, index) =>
      text(category, 160, `${path}.categories[${index}]`, true),
    )
    list(item.series, 1, item.chart === 'pie' ? 1 : 12, `${path}.series`)
    const count = item.categories.length
    item.series.forEach((entry, index) => {
      const series = record(entry, ['name', 'values'], `${path}.series[${index}]`)
      text(series.name, 160, `${path}.series[${index}].name`, true)
      list(series.values, count, count, `${path}.series[${index}].values`)
      series.values.forEach((value, point) =>
        number(
          value,
          item.chart === 'pie' ? 0 : -1e12,
          1e12,
          `${path}.series[${index}].values[${point}]`,
        ),
      )
      if (item.chart === 'pie' && !series.values.some((value) => (value as number) > 0))
        reject(`${path}.series[${index}]`, 'pie values must have a positive total')
    })
    list(item.colors, 1, 12, `${path}.colors`)
    item.colors.forEach((value, index) => color(value, `${path}.colors[${index}]`))
    choice(item.showLegend, [true, false], `${path}.showLegend`)
  }
}

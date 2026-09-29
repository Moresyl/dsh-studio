import {
  parsePresentation,
  PRESENTATION_TITLE_LIMIT,
  type PresentationDocument,
  type PresentationSlide,
} from './document'

export function blankSlide(title: string): PresentationSlide {
  return { id: crypto.randomUUID(), title, notes: '', background: 'FFFFFF', elements: [] }
}

export function newPresentation(title: string): PresentationDocument {
  return parsePresentation({
    format: 'dsh-studio-presentation',
    version: 1,
    id: crypto.randomUUID(),
    title,
    aspect: 'wide',
    slides: [blankSlide(title)],
  })
}

/** Fork all identities so future editing cannot alias a page or object in its source. */
export function copyPresentation(source: unknown, suffix: string): PresentationDocument {
  const document = parsePresentation(source)
  if (!suffix.trim() || suffix.length > 80) throw new Error('Invalid presentation copy suffix')
  const ending = ` (${suffix})`
  let title = document.title.slice(0, PRESENTATION_TITLE_LIMIT - ending.length)
  // Do not cut a surrogate pair at the UTF-16 title limit.
  if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1)
  document.title = title + ending
  document.id = crypto.randomUUID()
  for (const slide of document.slides) {
    slide.id = crypto.randomUUID()
    for (const element of slide.elements) element.id = crypto.randomUUID()
  }
  return parsePresentation(document)
}

/** Keep recent undo snapshots within both a count and UTF-16 memory budget. */
export function retainHistory(history: readonly string[], snapshot: string): string[] {
  const result = [...history, snapshot].slice(-100)
  let bytes = result.reduce((sum, item) => sum + item.length * 2, 0)
  while (bytes > 8 * 1024 * 1024 && result.length > 0) {
    bytes -= result.shift()!.length * 2
  }
  return result
}

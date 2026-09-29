import { parsePresentation, type PresentationDocument, type PresentationSlide } from './document'

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

/** Keep recent undo snapshots within both a count and UTF-16 memory budget. */
export function retainHistory(history: readonly string[], snapshot: string): string[] {
  const result = [...history, snapshot].slice(-100)
  let bytes = result.reduce((sum, item) => sum + item.length * 2, 0)
  while (bytes > 8 * 1024 * 1024 && result.length > 0) {
    bytes -= result.shift()!.length * 2
  }
  return result
}

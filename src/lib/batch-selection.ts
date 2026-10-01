/** A change of view invalidates its selection; hidden records are never affected. */
export interface SessionSelection {
  scope: string
  ids: string[]
}
export function visibleSelection(
  selection: SessionSelection,
  scope: string,
  visible: string[],
): string[] {
  if (selection.scope !== scope) return []
  const allowed = new Set(visible)
  return [...new Set(selection.ids)].filter((id) => allowed.has(id)).slice(0, 500)
}
export function toggleSelection(ids: string[], id: string): string[] {
  return ids.includes(id)
    ? ids.filter((selected) => selected !== id)
    : ids.length < 500
      ? [...ids, id]
      : ids
}

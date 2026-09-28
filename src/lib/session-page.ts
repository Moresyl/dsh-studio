/** Bound mounted transcript rows without truncating the source or its exports. */
export const SESSION_PAGE_SIZE = 120

export function sessionPage(
  lines: readonly { seq: number }[],
  requested: number | null,
  anchor: number | null,
) {
  const pages = Math.max(1, Math.ceil(lines.length / SESSION_PAGE_SIZE))
  const anchored =
    anchor === null
      ? 0
      : Math.max(
          0,
          lines.findIndex((line) => line.seq === anchor),
        )
  const preferred = requested ?? Math.floor(anchored / SESSION_PAGE_SIZE)
  const page = Math.min(
    pages - 1,
    Math.max(0, Number.isFinite(preferred) ? Math.floor(preferred) : 0),
  )
  const start = page * SESSION_PAGE_SIZE
  return { page, pages, start, end: Math.min(lines.length, start + SESSION_PAGE_SIZE) }
}

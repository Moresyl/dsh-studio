/** Numbers and dates as a metadata line writes them. */

/** Compact enough to sit beside a name: 12,400 becomes 12.4k. */
export const count = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value)

/**
 * A publish date, in whatever order the user's own locale writes one.
 *
 * Returned unchanged when it will not parse: a registry that answers with
 * something unexpected should show what it said, not `Invalid Date`.
 */
export const day = (iso: string): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

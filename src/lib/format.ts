/** Numbers and dates as a metadata line writes them. */

/** Compact enough to sit beside a name: 12,400 becomes 12.4k. */
export const count = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value)

/**
 * A transfer size, in the unit a download is talked about in.
 *
 * Megabytes throughout rather than a unit that grows with the value: this
 * measures one kind of thing — a runtime archive, tens of megabytes — and a
 * counter that jumped from KB to MB partway through would read as a glitch. The
 * divisor is 1000, matching what the release page beside it prints.
 */
export const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`

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

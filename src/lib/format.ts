/** Numbers, dates and paths as a metadata line writes them. */
import { t } from '@/lib/i18n'

/** Past this, "3 days ago" stops locating anything and a date starts to. */
const WEEK = 7 * 86_400_000

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
 * A file's size, in whichever unit keeps it readable.
 *
 * The unit moves here where `megabytes` fixes it, and for the same reason that
 * one does not: this measures files with no scale of their own — a plugin
 * archive is as likely to be 40 KB as 40 MB — so a fixed unit would print
 * `0.0 MB` for half of them. Rounded up rather than to zero, because a file
 * that exists has a size.
 */
export const filesize = (bytes: number): string =>
  bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`

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

/**
 * How long ago, until that stops being the useful thing to say.
 *
 * Deliberately not the rule the remote pane follows: its subjects are phones
 * seen minutes ago, and these go back as far as the machine does — "112 d ago"
 * is a number nobody converts back into a week.
 */
export function when(ms: number): string {
  if (ms <= 0) return ''

  const since = Date.now() - ms
  if (since < 60_000) return t('when.now')
  if (since < 3_600_000) return t('when.minutes', { count: Math.floor(since / 60_000) })
  if (since < 86_400_000) return t('when.hours', { count: Math.floor(since / 3_600_000) })
  if (since < WEEK) return t('when.days', { count: Math.floor(since / 86_400_000) })
  return day(new Date(ms).toISOString())
}

/** The last segment of a path, which is what people call the directory. */
export function leaf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1) || path
}

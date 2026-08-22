import type { LogLine } from '@/lib/ipc'

export type LogTone = 'normal' | 'warning' | 'error'

/**
 * stderr is a transport, not a severity.
 *
 * npm deliberately writes progress, cache hits and lifecycle headings to
 * stderr. Painting that whole stream red hides the one line that actually
 * failed, so only the well-known non-error forms are downgraded here. Unknown
 * stderr stays red; this must never make a new failure easy to miss.
 */
export function logTone(entry: LogLine): LogTone {
  if (entry.stream !== 'stderr') return 'normal'

  const line = entry.line.replace(/\x1b\[[0-9;]*m/g, '').trimStart()
  if (/^npm warn\b/i.test(line)) return 'warning'
  if (/^npm (?:http|info|notice|verbose|verb)\b/i.test(line)) return 'normal'
  if (/^(?:>|Progress:|added \d+ packages?\b|up to date\b)/i.test(line)) return 'normal'

  return 'error'
}

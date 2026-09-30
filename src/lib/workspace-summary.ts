import type { SessionCard } from '@/lib/ipc'

export interface WorkspaceSummary {
  path: string
  current: boolean
  sessions: number
  turns: number
  tokens: number
  touched: number
}

/** Only Windows paths ignore case; distinct Unix paths remain distinct. */
export function workspaceKey(path: string): string {
  return /^[a-z]:[\\/]|^\\\\/i.test(path)
    ? path.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase()
    : path.replace(/\/+$/, '') || '/'
}

export function workspaceSummaries(
  cards: SessionCard[],
  current: string | null,
): WorkspaceSummary[] {
  const groups = new Map<string, WorkspaceSummary>()
  if (current)
    groups.set(workspaceKey(current), {
      path: current,
      current: true,
      sessions: 0,
      turns: 0,
      tokens: 0,
      touched: 0,
    })
  for (const card of cards) {
    if (!card.project) continue
    const key = workspaceKey(card.project)
    const item = groups.get(key) ?? {
      path: card.project,
      current: false,
      sessions: 0,
      turns: 0,
      tokens: 0,
      touched: 0,
    }
    item.sessions += 1
    item.turns += card.turns
    item.tokens += card.tokens.input + card.tokens.output
    item.touched = Math.max(item.touched, card.touched)
    groups.set(key, item)
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      b.touched - a.touched ||
      a.path.localeCompare(b.path),
  )
}

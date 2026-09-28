import type { GitChange } from '@/lib/ipc'

/** Porcelain columns describe the index and worktree independently. */
export function changeCounts(changes: GitChange[]) {
  return changes.reduce(
    (counts, change) => {
      if (change.index === '?') counts.untracked += 1
      else {
        if (change.index !== ' ' && change.index !== '!') counts.staged += 1
        if (change.worktree !== ' ' && change.worktree !== '!') counts.unstaged += 1
      }
      return counts
    },
    { staged: 0, unstaged: 0, untracked: 0 },
  )
}

export function diffLineKind(line: string): 'file' | 'hunk' | 'added' | 'removed' | 'context' {
  if (line.startsWith('diff --git ') || line.startsWith('+++ ') || line.startsWith('--- '))
    return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  return 'context'
}

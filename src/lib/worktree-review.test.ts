import { describe, expect, it } from 'vitest'

import { changeCounts, diffLineKind } from '@/lib/worktree-review'

describe('read-only change presentation', () => {
  it('counts index, working copy and untracked entries separately', () => {
    const changes = ['M ', ' M', 'MM', '??', '!!', 'R ', 'UU'].map((status, index) => ({
      path: `${index}.txt`,
      previousPath: null,
      index: status.charAt(0),
      worktree: status.charAt(1),
    }))
    expect(changeCounts(changes)).toEqual({ staged: 4, unstaged: 3, untracked: 1 })
    expect(changeCounts([])).toEqual({ staged: 0, unstaged: 0, untracked: 0 })
  })

  it.each([
    ['diff --git a/file b/file', 'file'],
    ['+++ b/file', 'file'],
    ['--- a/file', 'file'],
    ['@@ -1 +1 @@', 'hunk'],
    ['+added', 'added'],
    ['-removed', 'removed'],
    [' context', 'context'],
    ['Binary files differ', 'context'],
    ['', 'context'],
    ['+<script>alert(1)</script>', 'added'],
  ] as const)('classifies %s without parsing content as markup', (line, expected) => {
    expect(diffLineKind(line)).toBe(expected)
  })
})

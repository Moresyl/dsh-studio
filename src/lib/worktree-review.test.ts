import { describe, expect, it } from 'vitest'

import { changeCounts, diffLineKind, diffPath, diffFiles, splitDiff } from '@/lib/worktree-review'

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

describe('file-based numbered diffs', () => {
  it('decodes quoted Git paths without interpreting markup', () => {
    expect(diffPath('"b/\\344\\270\\255\\346\\226\\207 file.ts"')).toBe('b/中文 file.ts')
    expect(diffPath('"b/a\\tline\\n\\\\\\\".ts"')).toBe('b/a\tline\n\\".ts')
    expect(diffPath('b/<script>literal</script>')).toBe('b/<script>literal</script>')
    expect(diffPath('"b/😀.ts"')).toBe('b/😀.ts')
  })
  it('tracks old and new lines across multiple hunks and files', () => {
    const files = diffFiles(
      'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,2 +20,3 @@\n same\n-old\n+new\n+extra\n@@ -30 +41 @@ title\n tail\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -0,0 +1 @@\n+<script>literal</script>\n',
    )
    expect(files.map((file) => file.label)).toEqual(['a', 'b'])
    expect(files[0]!.lines.slice(4, 8).map(({ before, after }) => [before, after])).toEqual([
      [10, 20],
      [11, null],
      [null, 21],
      [null, 22],
    ])
    expect(files[0]!.lines.at(-1)).toMatchObject({ before: 30, after: 41 })
    expect(files[1]!.lines.at(-1)).toMatchObject({
      text: '+<script>literal</script>',
      before: null,
      after: 1,
    })
  })
  it('keeps binary and rename metadata, deletion paths and no-newline notices', () => {
    const files = diffFiles(
      'diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\ndiff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-text\n\\ No newline at end of file\ndiff --git a/image b/image\nBinary files a/image and b/image differ\n',
    )
    expect(files).toHaveLength(3)
    expect(files[0]!.label).toBe('new')
    expect(files[1]!.label).toBe('gone')
    expect(files[1]!.lines.at(-1)?.before).toBeNull()
    expect(files[2]!.lines.at(-1)?.text).toContain('Binary files')
    expect(files[2]!.label).toBe('image')
    expect(diffFiles('')).toEqual([])
    expect(splitDiff([])).toEqual([])
  })
  it('selects binary and mode-only files with spaces or quoted UTF-8 paths', () => {
    expect(
      diffFiles('diff --git a/foo b/bar b/foo b/bar\nold mode 100644\nnew mode 100755\n')[0]!.label,
    ).toBe('foo b/bar')
    expect(
      diffFiles(
        'diff --git "a/\\344\\270\\255.bin" "b/\\344\\270\\255.bin"\nBinary files differ\n',
      )[0]!.label,
    ).toBe('中.bin')
    expect(
      diffFiles(
        'diff --git a/original b/copied file\ncopy from original\ncopy to copied file\n',
      )[0]!.label,
    ).toBe('copied file')
  })
  it('pairs unequal edit blocks and keeps unchanged lines and annotations', () => {
    const files = diffFiles(
      'diff --git a/a b/a\n@@ -1,4 +1,3 @@\n same\n-one\n-two\n+replacement\n tail\n+extra\n',
    )
    const rows = splitDiff(files[0]!.lines)
    expect(rows[0]!.metadata?.text).toContain('diff --git')
    expect(rows[2]).toMatchObject({ before: { before: 1 }, after: { after: 1 } })
    expect(rows[3]).toMatchObject({ before: { text: '-one' }, after: { text: '+replacement' } })
    expect(rows[4]).toMatchObject({ before: { text: '-two' }, after: null })
    expect(rows.at(-1)).toMatchObject({ before: null, after: { text: '+extra' } })
  })
})

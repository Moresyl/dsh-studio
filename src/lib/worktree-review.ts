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

export interface DiffLine {
  text: string
  kind: ReturnType<typeof diffLineKind>
  before: number | null
  after: number | null
}
export interface DiffFile {
  label: string
  lines: DiffLine[]
}

/** Git quotes unusual path bytes with octal escapes, independently of JSON. */
export function diffPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const text = value.slice(1, -1),
    bytes: number[] = []
  const escapes: Record<string, string> = {
    t: '\t',
    n: '\n',
    r: '\r',
    b: '\b',
    f: '\f',
    v: '\v',
    a: '\x07',
  }
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') {
      const octal = /^[0-7]{3}/.exec(text.slice(i + 1))
      if (octal) {
        bytes.push(parseInt(octal[0], 8))
        i += 4
        continue
      }
      const escaped = text[i + 1]
      if (escaped !== undefined) {
        bytes.push(...new TextEncoder().encode(escapes[escaped] ?? escaped))
        i += 2
        continue
      }
    }
    const point = String.fromCodePoint(text.codePointAt(i)!)
    bytes.push(...new TextEncoder().encode(point))
    i += point.length
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** Preserve metadata and binary notices; only hunk content receives line numbers. */
export function diffFiles(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null,
    before: number | null = null,
    after: number | null = null
  const source = patch.split('\n')
  if (source.at(-1) === '') source.pop()
  for (const text of source) {
    if (text.startsWith('diff --git ') || file === null) {
      file = { label: text.replace(/^diff --git /, ''), lines: [] }
      files.push(file)
      before = null
      after = null
    }
    if (text.startsWith('+++ ') && text !== '+++ /dev/null')
      file.label = diffPath(text.slice(4)).replace(/^b\//, '')
    else if (text.startsWith('--- ') && text !== '--- /dev/null')
      file.label = diffPath(text.slice(4)).replace(/^a\//, '')
    else if (text.startsWith('rename to ')) file.label = diffPath(text.slice(10))
    const kind = diffLineKind(text)
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      before = Number(hunk[1])
      after = Number(hunk[2])
    }
    const numbered =
      before !== null &&
      after !== null &&
      (text[0] === ' ' || kind === 'added' || kind === 'removed')
    file.lines.push({
      text,
      kind,
      before: numbered && kind !== 'added' ? before : null,
      after: numbered && kind !== 'removed' ? after : null,
    })
    if (numbered) {
      if (kind !== 'added') before!++
      if (kind !== 'removed') after!++
    }
  }
  return files
}

export interface SplitLine {
  before: DiffLine | null
  after: DiffLine | null
  metadata?: DiffLine
}
export function splitDiff(lines: DiffLine[]): SplitLine[] {
  const rows: SplitLine[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    if (line.kind === 'removed' || line.kind === 'added') {
      const removed: DiffLine[] = [],
        added: DiffLine[] = []
      while (lines[index]?.kind === 'removed') removed.push(lines[index++]!)
      while (lines[index]?.kind === 'added') added.push(lines[index++]!)
      for (let n = 0; n < Math.max(removed.length, added.length); n++)
        rows.push({ before: removed[n] ?? null, after: added[n] ?? null })
    } else {
      rows.push(
        line.before !== null
          ? { before: line, after: line }
          : { before: null, after: null, metadata: line },
      )
      index++
    }
  }
  return rows
}

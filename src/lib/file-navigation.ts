/** Browser-local history; it never changes the selected Harness workspace. */
export interface FileNavigation {
  paths: string[]
  cursor: number
}

export function visitFolder(history: FileNavigation, path: string): FileNavigation {
  if (history.paths[history.cursor] === path) return history
  const paths = [...history.paths.slice(0, history.cursor + 1), path].slice(-50)
  return { paths, cursor: paths.length - 1 }
}

export function stepFolder(history: FileNavigation, direction: -1 | 1): FileNavigation {
  const cursor = history.cursor + direction
  return cursor < 0 || cursor >= history.paths.length ? history : { ...history, cursor }
}

/** Preserve the last empty line and normalize CRLF without modifying copied text. */
export function previewLines(text: string): string[] {
  return text.split(/\r?\n/, 5000)
}

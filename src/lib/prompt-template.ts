/** Variable names are deliberately narrow; prompt text is never evaluated. */
export function promptVariables(body: string): string[] {
  return [
    ...new Set(
      Array.from(body.matchAll(/\{\{\s*([\p{L}\p{N}_ -]{1,48}?)\s*\}\}/gu), (match) =>
        match[1]!.trim(),
      ),
    ),
  ].filter(Boolean)
}

export function renderPrompt(body: string, values: ReadonlyMap<string, string>): string {
  return body.replace(
    /\{\{\s*([\p{L}\p{N}_ -]{1,48}?)\s*\}\}/gu,
    (original, key: string) => values.get(key.trim())?.trim() || original,
  )
}

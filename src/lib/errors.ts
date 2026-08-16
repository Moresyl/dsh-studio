/**
 * One reading of a rejected command, shared by every store.
 *
 * Tauri rejects with the `Display` text of the Rust error, so the useful case is
 * a plain string — but a thrown value is still `unknown`, and a store that
 * rendered `[object Object]` into its error slot would be hiding the one thing
 * the user needed to read.
 */
export const describe = (cause: unknown): string =>
  typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : String(cause)

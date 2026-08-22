export type ClipboardAction = 'copy' | 'paste'

type KeyGesture = Pick<
  KeyboardEvent,
  'type' | 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
>

/** The native clipboard gesture for xterm on this platform, if this is one. */
export function clipboardAction(event: KeyGesture, mac: boolean): ClipboardAction | null {
  if (event.type !== 'keydown' || event.altKey) return null

  const modifier = mac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey
  if (!modifier) return null

  const key = event.key.toLowerCase()
  return key === 'c' ? 'copy' : key === 'v' ? 'paste' : null
}

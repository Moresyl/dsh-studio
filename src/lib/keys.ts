/**
 * Key combinations, in the one spelling both sides of the app agree on.
 *
 * A browser reports a key as `event.code` — the physical key, `KeyD` rather than
 * `d` — and the hotkey parser in `src-tauri/src/startup.rs` reads exactly that
 * vocabulary. So a recorded combination travels to Rust unchanged, and this
 * module is only the two ends of that: reading a keypress into the string, and
 * writing the string back out for a person to read.
 *
 * Nothing here is localised. `Ctrl` and `Shift` are what the keys have printed
 * on them, and a translated modifier is one nobody can find on a keyboard.
 */

/** Modifier order, which is the order every platform's own menus print. */
const ORDER = ['Control', 'Alt', 'Shift', 'Super'] as const

type Modifier = (typeof ORDER)[number]

/** How each modifier is written, once for a Mac and once for everywhere else. */
const SIGNS: Record<Modifier, { mac: string; other: string }> = {
  Control: { mac: '⌃', other: 'Ctrl' },
  Alt: { mac: '⌥', other: 'Alt' },
  Shift: { mac: '⇧', other: 'Shift' },
  Super: { mac: '⌘', other: 'Win' },
}

/**
 * Keys whose `code` is not already the name to print.
 *
 * Everything else is handled by the two rules below — strip the `Key` or `Digit`
 * prefix — which covers every letter and number without a table.
 */
const NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
}

/** A press that is only a modifier — held on the way to the real key. */
const BARE = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
])

/**
 * The combination a keypress describes, or `null` while it describes nothing yet.
 *
 * `null` covers both a modifier held on its own and a combination Rust would
 * refuse — a global key with no reaching modifier would be taken away from every
 * other program on the machine, so the recorder simply keeps waiting rather than
 * offering something that cannot be saved.
 */
export function readCombination(event: {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string | null {
  if (BARE.has(event.code) || event.code === '') return null

  const parts: string[] = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Super')

  // Shift is missing from this test deliberately: Shift and a letter is a
  // capital letter, and claiming one would take every capital D on the machine.
  if (!(event.ctrlKey || event.altKey || event.metaKey)) return null

  parts.push(event.code)
  return parts.join('+')
}

/**
 * The same combination, written the way the platform writes one.
 *
 * Returned as parts rather than a string so a caller can set each in its own
 * `<kbd>`, which is what makes a recorded shortcut read as keys rather than as
 * a sentence with plus signs in it.
 *
 * Which platform is an argument and not something this reads for itself: it is
 * the only thing here that is not a pure function of the accelerator, and one
 * argument buys both spellings under test on whichever machine runs it.
 */
export function spellCombination(accelerator: string, mac: boolean): string[] {
  return accelerator
    .split('+')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((token) => sign(token, mac))
}

function sign(token: string, mac: boolean): string {
  // The platform-neutral token Rust suggests, which is a real modifier here.
  if (/^(?:Cmd|Command)Or(?:Ctrl|Control)$/i.test(token)) {
    return mac ? SIGNS.Super.mac : SIGNS.Control.other
  }

  const known = ORDER.find((modifier) => modifier.toLowerCase() === token.toLowerCase())
  if (known) return mac ? SIGNS[known].mac : SIGNS[known].other

  if (/^Key[A-Z]$/.test(token)) return token.slice(3)
  if (/^Digit\d$/.test(token)) return token.slice(5)
  if (/^Numpad./.test(token)) return `Num ${token.slice(6)}`
  return NAMES[token] ?? token
}

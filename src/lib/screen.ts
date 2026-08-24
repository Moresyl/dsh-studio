/**
 * The xterm instances behind the terminal tabs.
 *
 * A registry in a module rather than state in a component, because a terminal is
 * a live thing with a shell attached and a transcript worth keeping: the pane
 * showing it is allowed to unmount — the user looks at the plugin market, or at
 * the harness itself — and everything printed while they were away has to be
 * there when they come back. React state cannot promise that, and rebuilding the
 * emulator on every visit would throw the transcript away without saying so.
 *
 * So the element each terminal renders into is created here, once, and moved
 * between hosts. Nothing else in this app owns DOM this way, and nothing else
 * should: a terminal is the one part of it that is more document than view.
 */
import { readText } from '@tauri-apps/plugin-clipboard-manager'
import { openUrl } from '@tauri-apps/plugin-opener'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ITheme } from '@xterm/xterm'

import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { isMac, isWindows } from '@/lib/platform'
import { clipboardAction } from '@/lib/terminal-shortcuts'

import '@xterm/xterm/css/xterm.css'

/** One terminal: the emulator, the thing that sizes it, and where it draws. */
export interface Screen {
  terminal: Terminal
  fit: FitAddon
  /** Made here and moved between hosts, never rebuilt. */
  root: HTMLDivElement
}

/** How much scrollback a terminal keeps. Lines, per terminal. */
const SCROLLBACK = 5000

/** Ceiling on output held for a shell whose id has not come back yet. */
const EARLY_LIMIT = 64 * 1024

const screens = new Map<string, Screen>()

/**
 * Where a clipboard or command failure goes.
 *
 * A hook rather than a direct call into the store, because the store is what
 * imports this module — the dependency has to point one way, and it points from
 * the state that owns the tabs towards the emulator it drives.
 */
const sink = { report: (_cause: unknown) => {} }

export const reportProblemsTo = (report: (cause: unknown) => void): void => {
  sink.report = report
}

/**
 * Output that arrived for a shell before its id got back to the frontend.
 *
 * `terminal_open` starts reading the pty before it returns, so a shell that
 * prints a prompt at once can beat its own id across the IPC boundary. One slot
 * is enough: only one terminal is ever being opened at a time, and a slot holding
 * some earlier id is by then holding output nobody will ever ask for.
 */
let early: { id: string; text: string } | null = null

/* -------------------------------------------------------------------------- */
/* The palette                                                                */
/* -------------------------------------------------------------------------- */

/** One custom property, with the newlines a multi-line value carries removed. */
const token = (style: CSSStyleDeclaration, name: string): string =>
  style.getPropertyValue(name).replace(/\s+/g, ' ').trim()

/**
 * The terminal's colours, read from the stylesheet.
 *
 * From the cascade rather than from a constant here, so the answer is already
 * correct in all three of this window's states — dark, light, and following the
 * system — without any code deciding which one is in force.
 */
function palette(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const of = (name: string) => token(style, name)

  return {
    background: of('--color-canvas-deep'),
    foreground: of('--color-text'),
    cursor: of('--color-brand'),
    // The ink a block cursor prints its character in: the ground, so the glyph
    // under the cursor reads as inverted rather than as two colours fighting.
    cursorAccent: of('--color-canvas-deep'),
    selectionBackground: of('--term-selection'),
    black: of('--term-black'),
    red: of('--term-red'),
    green: of('--term-green'),
    yellow: of('--term-yellow'),
    blue: of('--term-blue'),
    magenta: of('--term-magenta'),
    cyan: of('--term-cyan'),
    white: of('--term-white'),
    brightBlack: of('--term-bright-black'),
    brightRed: of('--term-bright-red'),
    brightGreen: of('--term-bright-green'),
    brightYellow: of('--term-bright-yellow'),
    brightBlue: of('--term-bright-blue'),
    brightMagenta: of('--term-bright-magenta'),
    brightCyan: of('--term-bright-cyan'),
    brightWhite: of('--term-bright-white'),
  }
}

/** This application's own words inside the transcript, kept out of the way. */
const aside = (text: string): string => `\x1b[90m${text}\x1b[0m`

/* -------------------------------------------------------------------------- */
/* Making and ending a terminal                                               */
/* -------------------------------------------------------------------------- */

function create(): Screen {
  const style = getComputedStyle(document.documentElement)

  const terminal = new Terminal({
    // Unicode11Addon registers a width provider through xterm's proposed
    // `unicode` API. xterm 6 refuses that API unless the terminal opts in
    // before the addon activates, which otherwise makes New terminal throw
    // before the PTY is even opened.
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'bar',
    // Outlined while the pane is not focused, which is how a terminal says the
    // keyboard is somewhere else without going invisible.
    cursorInactiveStyle: 'outline',
    // A bold red must stay red. Brightening it instead is a DEC habit that turns
    // a hand-picked palette into eight colours and eight surprises.
    drawBoldTextInBrightColors: false,
    fontFamily: token(style, '--font-mono'),
    fontSize: 13,
    fontWeightBold: 600,
    lineHeight: 1.3,
    // ⌥ as Meta, so Emacs bindings work on a Mac keyboard at all.
    macOptionIsMeta: true,
    scrollback: SCROLLBACK,
    theme: palette(),
    // What the pty layer actually is on Windows, which is what tells xterm not to
    // reflow lines the console host has already reflowed for it.
    ...(isWindows ? { windowsPty: { backend: 'conpty' as const } } : {}),
  })

  const fit = new FitAddon()
  terminal.loadAddon(fit)
  // The harness and common shell tools use box drawing, CJK and emoji. xterm's
  // legacy width table misplaces those cells, making a TUI appear to lose its
  // borders or overwrite text even though the PTY delivered every byte.
  const unicode = new Unicode11Addon()
  terminal.loadAddon(unicode)
  terminal.unicode.activeVersion = '11'
  // A link goes to the user's own browser. The default would hand it to the
  // webview, and a webview showing somebody's website is not this application.
  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault()
      void openUrl(uri)
    }),
  )

  terminal.attachCustomKeyEventHandler((event) => clipboardKeys(terminal, event))

  // Taken out of flow deliberately. Switching tabs moves one root out of the
  // host and another in, and for the frame between those two the host holds
  // both; in flow that frame is a host of double height, which is also the box
  // the fitter would measure. Out of flow, the two simply overlap and the size
  // the fitter reads is the pane's, whatever else is in there.
  const root = document.createElement('div')
  root.style.position = 'absolute'
  root.style.inset = '0'

  return { terminal, fit, root }
}

/**
 * The two clipboard keystrokes a terminal has to answer itself.
 *
 * Ctrl+C belongs to the shell — it is how a person stops something — so copying
 * moves up one modifier, which is the bargain every terminal emulator on Windows
 * and Linux has struck. Paste is offered at the same place for symmetry; plain
 * Ctrl+V is deliberately left alone, because the webview already pastes into
 * xterm's own input natively and doing it twice would double every paste.
 *
 * Returning false keeps xterm from also sending the keystroke to the shell.
 */
function clipboardKeys(terminal: Terminal, event: KeyboardEvent): boolean {
  const action = clipboardAction(event, isMac)
  if (action === null) return true

  event.preventDefault()
  if (action === 'copy') {
    const selection = terminal.getSelection()
    // Nothing highlighted is not a failed copy; it is a keystroke with nothing
    // to do, and replacing the clipboard with an empty string would be worse.
    if (selection.length > 0) void navigator.clipboard.writeText(selection).catch(sink.report)
  } else {
    pasteInto(terminal)
  }
  return false
}

/**
 * Through xterm's `paste` rather than as input, so bracketed paste mode is
 * honoured and a shell that asked to be told about pastes is told.
 */
function pasteInto(terminal: Terminal): void {
  readText().then((text) => terminal.paste(text), sink.report)
}

/** Paste into a terminal by id, which is what the context menu has. */
export function paste(id: string): void {
  const screen = screens.get(id)
  if (screen) pasteInto(screen.terminal)
}

/** Copy xterm's canvas selection, which the webview cannot copy by itself. */
export function copy(id: string): void {
  const chosen = selection(id)
  if (chosen.length > 0) void navigator.clipboard.writeText(chosen).catch(sink.report)
}

/**
 * Make a terminal, put it in `host`, and report the size it came out as.
 *
 * The size is the reason this is separate from [`adopt`]: a shell has to be
 * started at the size of the pane that will show it, and that is only knowable
 * once the emulator has measured itself against a real box.
 */
export function open(host: HTMLElement): { screen: Screen; rows: number; cols: number } {
  const screen = create()
  host.appendChild(screen.root)
  screen.terminal.open(screen.root)
  screen.fit.fit()

  return { screen, rows: screen.terminal.rows, cols: screen.terminal.cols }
}

/** Bind a screen to the shell that came back, and hand over anything held. */
export function adopt(id: string, screen: Screen): void {
  screens.set(id, screen)

  screen.terminal.onData((data) => {
    ipc.terminalWrite(id, data).catch(sink.report)
  })
  // The one place a size change is reported. Every path that changes the size —
  // a fit, a pane that grew, a window that was maximised — ends up here.
  screen.terminal.onResize(({ rows, cols }) => {
    ipc.terminalResize(id, rows, cols).catch(sink.report)
  })

  if (early?.id === id) {
    screen.terminal.write(early.text)
    early = null
  }
}

/** Throw away a screen whose shell never started. */
export function discard(screen: Screen): void {
  screen.terminal.dispose()
  screen.root.remove()
}

/**
 * Give a shell that outlived this window's last render a new screen.
 *
 * What happens after a reload in development, and after anything that rebuilds
 * the page while the pty keeps running. The shell is still there and still
 * typeable; the transcript is not, and the terminal says so rather than looking
 * like a shell that printed nothing.
 */
export function restore(id: string, host: HTMLElement): void {
  const { screen, rows, cols } = open(host)
  adopt(id, screen)

  ipc.terminalResize(id, rows, cols).catch(sink.report)
  screen.terminal.writeln(aside(t('terminal.reattached')))
}

/** Put a terminal back on screen, sized to the host it is going into. */
export function attach(id: string, host: HTMLElement): void {
  const screen = screens.get(id)
  if (!screen) return

  if (screen.root.parentElement !== host) host.appendChild(screen.root)
  screen.fit.fit()
  // Written to while its element was out of the document, a terminal can hold
  // rows nothing ever painted. Cheap enough to do on every visit.
  screen.terminal.refresh(0, screen.terminal.rows - 1)
  screen.terminal.focus()
}

/** Take a terminal off screen without ending it. */
export function detach(id: string): void {
  screens.get(id)?.root.remove()
}

/** Re-fit to the host, which is what tells the shell its new size. */
export function measure(id: string): void {
  screens.get(id)?.fit.fit()
}

export function focus(id: string): void {
  screens.get(id)?.terminal.focus()
}

/** Empty the visible screen, the way a shell's own `clear` would. */
export function clear(id: string): void {
  screens.get(id)?.terminal.clear()
}

/** What the user has highlighted in a terminal, if anything. */
export const selection = (id: string): string => screens.get(id)?.terminal.getSelection() ?? ''

/** Show output, holding it briefly if the id is not bound to a screen yet. */
export function write(id: string, data: string): void {
  const screen = screens.get(id)
  if (screen) {
    screen.terminal.write(data)
    return
  }

  if (early?.id !== id) early = { id, text: '' }
  // Past the ceiling the head is what is worth keeping: it is the prompt and the
  // banner, and everything after it will arrive again through the screen.
  if (early.text.length < EARLY_LIMIT) early.text += data
}

/**
 * Turn a terminal into the transcript of one, its shell having finished.
 *
 * The tab is deliberately left behind rather than swept away, because a shell
 * that exited badly is a shell whose last twenty lines are the reason. Input is
 * closed off: there is nothing at the other end of it any more.
 */
export function retire(id: string, code: number | null): void {
  const screen = screens.get(id)
  if (!screen) return

  screen.terminal.options.disableStdin = true
  screen.terminal.options.cursorBlink = false
  screen.terminal.options.cursorInactiveStyle = 'none'
  screen.terminal.write(
    `\r\n${aside(code === null ? t('terminal.ended') : t('terminal.exited', { code }))}\r\n`,
  )
}

/** End a terminal for good, transcript and all. */
export function dispose(id: string): void {
  const screen = screens.get(id)
  if (!screen) return

  screens.delete(id)
  screen.terminal.dispose()
  screen.root.remove()
}

/** Whether a shell has a screen here, which a reloaded window needs to ask. */
export const has = (id: string): boolean => screens.has(id)

/* -------------------------------------------------------------------------- */
/* Following the window's light                                               */
/* -------------------------------------------------------------------------- */

/**
 * Repaint every terminal when the window changes light.
 *
 * Two triggers, because the resolved theme moves in two ways: `data-theme` being
 * written, and the system preference changing while "follow the system" is the
 * choice — which writes no attribute at all. Neither is asked what the answer
 * is; the palette is re-read from the cascade, which already knows.
 */
export function followTheme(): () => void {
  const repaint = () => {
    const theme = palette()
    for (const screen of screens.values()) screen.terminal.options.theme = theme
  }

  const attribute = new MutationObserver(repaint)
  attribute.observe(document.documentElement, { attributeFilter: ['data-theme'] })

  const system =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null
  system?.addEventListener('change', repaint)

  return () => {
    attribute.disconnect()
    system?.removeEventListener('change', repaint)
  }
}

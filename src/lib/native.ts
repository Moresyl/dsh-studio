/**
 * The behaviours a window has that a tab does not.
 *
 * A webview arrives with a browser's reflexes: F5 throws the application away
 * and rebuilds it, Ctrl+P offers to print it, Ctrl+scroll rescales the entire
 * interface, and a dropped file replaces the app with whatever was dropped.
 * None of that is a feature here — a user who reaches for one of them gets an
 * answer no desktop application would give, and that is the moment the window
 * stops reading as a program and starts reading as a page.
 *
 * So the reflexes are removed rather than styled over. What is left is a window
 * that does nothing when you press the browser's keys, which is exactly what
 * every other application on the machine does.
 */
import { Copy } from 'lucide-react'

import { t } from '@/lib/i18n'
import { selectedText, useMenu } from '@/state/menu'

/** Keys that only ever meant something to a browser. */
const BROWSER_KEYS = new Set([
  'r', // reload
  'f', // find
  'g', // find again
  'p', // print
  's', // save page
  'o', // open file
  'u', // view source
  'd', // bookmark
  'j', // downloads
  'h', // history
])

/** Zoom, in every spelling a keyboard produces. */
const ZOOM_KEYS = new Set(['+', '-', '=', '_', '0'])

/** Where a text shortcut still has to work, because there is text in it. */
const editable = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null

/**
 * Install them. Idempotent per document, and never removed — these hold for the
 * lifetime of the window.
 *
 * Development keeps reload and the inspector: the cost of losing them is paid
 * every few minutes by whoever is working on the app, and nobody ships a dev
 * build.
 */
export function behaveLikeAWindow(): void {
  window.addEventListener('keydown', onKeyDown)
  // Not passive, because the point is to be able to refuse it.
  window.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('dragover', prevent)
  window.addEventListener('drop', prevent)
  window.addEventListener('contextmenu', onContextMenu)
}

const prevent = (event: Event): void => event.preventDefault()

function onKeyDown(event: KeyboardEvent): void {
  const accel = event.ctrlKey || event.metaKey

  // Reload, and the inspector, are the two worth keeping while building.
  if (import.meta.env.DEV) {
    const reloading = event.key === 'F5' || (accel && event.key.toLowerCase() === 'r')
    const inspecting = event.key === 'F12' || (accel && event.shiftKey && event.key === 'I')
    if (reloading || inspecting) return
  }

  if (event.key === 'F5' || event.key === 'F3' || event.key === 'F12') {
    event.preventDefault()
    return
  }

  // The browser's back and forward. There is nowhere to go back to.
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault()
    return
  }

  if (!accel) return

  if (ZOOM_KEYS.has(event.key)) {
    event.preventDefault()
    return
  }

  // Select-all belongs to whatever is holding text, and to nothing else: with
  // the interface itself unselectable, a page-wide Ctrl+A only ever produced an
  // invisible selection and a stale clipboard.
  if (event.key.toLowerCase() === 'a' && !editable(event.target)) {
    event.preventDefault()
    return
  }

  if (BROWSER_KEYS.has(event.key.toLowerCase()) && !editable(event.target)) {
    event.preventDefault()
  }
}

/** Ctrl+wheel, and the trackpad pinch that arrives as one. */
function onWheel(event: WheelEvent): void {
  if (event.ctrlKey || event.metaKey) event.preventDefault()
}

/**
 * The last resort for a right-click, and the reason the browser's own menu is
 * never seen: it offers reload, back and view-source, three things this window
 * does not have, in a panel that belongs to another program.
 *
 * Anything with a menu of its own has already stopped this event. What reaches
 * here is plain selectable text, where the only thing to offer is the thing the
 * browser would have — copy — drawn the way the rest of the app is drawn.
 */
function onContextMenu(event: MouseEvent): void {
  event.preventDefault()

  const target = event.target
  if (!(target instanceof Element) || !target.closest('.selectable')) return

  const selection = selectedText()
  useMenu.getState().show(event.clientX, event.clientY, [
    {
      label: t('menu.copy'),
      icon: Copy,
      disabled: selection.length === 0,
      run: () => void navigator.clipboard.writeText(selection),
    },
  ])
}

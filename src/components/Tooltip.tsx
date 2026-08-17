import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** How long a pointer has to rest before the first tip appears. */
const DELAY = 460

/**
 * After one tip has been up, the next is immediate for this long.
 *
 * It is the difference between a toolbar that explains itself and a toolbar
 * that makes you wait half a second per button: once someone is reading labels,
 * they are reading labels.
 */
const WARM = 420

/** Between the tip and the thing it explains, and from the window's edge. */
const GAP = 7
const MARGIN = 6

interface Tip {
  text: string
  anchor: DOMRect
}

/**
 * The tooltips, drawn by the app.
 *
 * `title` is the browser's, and it shows: it waits a full second, it is drawn
 * in Edge's shape rather than this window's, it cannot hold a second line
 * without looking like an accident, and it survives a click that has already
 * moved the interface on. Every one of those is a small thing, and together
 * they are most of what makes a webview feel like a webview.
 *
 * So the attribute is `data-hint` and this reads it. One listener at the
 * document rather than a component per label: a tooltip is chrome around
 * something else, and nothing that carries one should have to be rewritten to
 * get it.
 */
export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })

  const surface = useRef<HTMLDivElement>(null)
  const anchor = useRef<Element | null>(null)
  const timer = useRef(0)
  const warmUntil = useRef(0)
  const shown = useRef(false)

  useEffect(() => {
    const disarm = () => {
      window.clearTimeout(timer.current)
      timer.current = 0
    }

    const hide = () => {
      disarm()
      anchor.current = null
      if (shown.current) {
        warmUntil.current = performance.now() + WARM
        shown.current = false
      }
      setTip(null)
    }

    const consider = (element: Element | null, immediate: boolean) => {
      if (!(element instanceof HTMLElement)) {
        hide()
        return
      }

      const text = element.dataset.hint
      if (!text) {
        hide()
        return
      }

      // Moving within the same control — button to the icon inside it — is not
      // a new tooltip, and re-arming the timer there is how a tip that is
      // already up starts flickering.
      if (anchor.current === element) return

      disarm()
      anchor.current = element

      const show = () => {
        shown.current = true
        setTip({ text, anchor: element.getBoundingClientRect() })
      }

      if (immediate || performance.now() < warmUntil.current) show()
      else timer.current = window.setTimeout(show, DELAY)
    }

    const onOver = (event: PointerEvent) => {
      // A tooltip is a pointer's question. Touch has no hover, and the tip it
      // would produce lands under the finger that asked for it.
      if (event.pointerType === 'touch') return
      consider(event.target instanceof Element ? event.target.closest('[data-hint]') : null, false)
    }

    // The keyboard's version: a control the user tabbed to says what it is,
    // without the wait a resting pointer has to serve.
    const onFocus = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.matches(':focus-visible')) return
      consider(target.closest('[data-hint]'), true)
    }

    window.addEventListener('pointerover', onOver)
    window.addEventListener('pointerdown', hide)
    window.addEventListener('keydown', hide)
    window.addEventListener('wheel', hide, { passive: true })
    window.addEventListener('blur', hide)
    window.addEventListener('focusin', onFocus)
    window.addEventListener('focusout', hide)
    document.addEventListener('pointerleave', hide)

    return () => {
      disarm()
      window.removeEventListener('pointerover', onOver)
      window.removeEventListener('pointerdown', hide)
      window.removeEventListener('keydown', hide)
      window.removeEventListener('wheel', hide)
      window.removeEventListener('blur', hide)
      window.removeEventListener('focusin', onFocus)
      window.removeEventListener('focusout', hide)
      document.removeEventListener('pointerleave', hide)
    }
  }, [])

  // Measured and placed before the frame it appears in, so it is never seen at
  // the corner first.
  useLayoutEffect(() => {
    const element = surface.current
    if (!tip || !element) return

    const { width, height } = element.getBoundingClientRect()
    const above = tip.anchor.top - height - GAP
    const below = tip.anchor.bottom + GAP

    setPosition({
      x: clamp(
        tip.anchor.left + tip.anchor.width / 2 - width / 2,
        MARGIN,
        window.innerWidth - width - MARGIN,
      ),
      // Above by default — that is where a tip stays out of the way of the
      // pointer that is on its way to the control.
      y: above >= MARGIN ? above : below,
    })
  }, [tip])

  if (!tip) return null

  return (
    <div
      ref={surface}
      role="tooltip"
      style={{ left: position.x, top: position.y }}
      className="pointer-events-none fixed z-60 max-w-[320px] animate-fade rounded-control border border-line-strong bg-surface px-2 py-1 text-[11.5px] leading-relaxed whitespace-pre-line text-text shadow-lift"
    >
      {tip.text}
    </div>
  )
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high))

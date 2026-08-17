import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

import { SEPARATOR, useMenu, type MenuAction, type MenuEntry } from '@/state/menu'

/** Kept off the window's edge by this much, the way a system menu is. */
const MARGIN = 6

/**
 * Eat one event.
 *
 * Module scope on purpose: it is armed inside an effect that is about to be
 * torn down by the very `hide()` next to it, and a listener removed in that
 * teardown would be gone before the click it is waiting for arrives. `once`
 * takes it off again.
 */
const swallow = (event: Event): void => {
  event.preventDefault()
  event.stopPropagation()
}

/**
 * The menu a right-click opens.
 *
 * Drawn rather than handed to the system on purpose. A Win32 menu would arrive
 * in the desktop's theme and ignore this one — light grey panel, system accent,
 * a font chosen elsewhere — and the one thing worse than an app with no context
 * menus is an app whose menus visibly belong to another program. This one is
 * the app's own surfaces, spacing and accent, and it behaves the way a system
 * menu behaves: it opens under the pointer, flips at the screen edge, follows
 * the arrow keys, and closes on Escape or on anything else the user does.
 */
export function ContextMenu() {
  const at = useMenu((state) => state.at)
  const entries = useMenu((state) => state.entries)
  const hide = useMenu((state) => state.hide)

  const surface = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [active, setActive] = useState(-1)

  // Placed after measuring, in the same frame — the menu never paints in the
  // wrong place first.
  useLayoutEffect(() => {
    const element = surface.current
    if (!at || !element) return

    // Handed back when the menu goes, so a menu opened over a search box does
    // not cost the user their cursor. A click that lands somewhere focusable
    // overrides this a moment later, which is the right outcome either way.
    const previous = document.activeElement

    const { width, height } = element.getBoundingClientRect()
    setPosition({
      // Flipped rather than merely pushed: a menu that overlaps the pointer's
      // own column hides what was right-clicked.
      x: at.x + width + MARGIN > window.innerWidth ? Math.max(MARGIN, at.x - width) : at.x,
      y: at.y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, at.y - height) : at.y,
    })
    setActive(-1)
    element.focus()

    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [at])

  // Anything that is not this menu dismisses it, which is the rule every system
  // menu follows. In the capture phase, so the press is taken before anything
  // underneath it can answer.
  useEffect(() => {
    if (!at) return

    const dismiss = (event: Event) => {
      if (event.target instanceof Node && surface.current?.contains(event.target)) return

      // The press that closes a menu is spent closing it: on every desktop
      // platform, the click that dismisses a menu does not also press what was
      // under it — the next click does. Stopping the press alone would not be
      // enough, because the click that follows would still land, so the click
      // is caught too, once, by a listener that outlives this effect.
      if (event.type === 'mousedown') {
        event.preventDefault()
        event.stopPropagation()
        window.addEventListener('click', swallow, { capture: true, once: true })
      }

      hide()
    }
    window.addEventListener('mousedown', dismiss, true)
    window.addEventListener('wheel', dismiss, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('mousedown', dismiss, true)
      window.removeEventListener('wheel', dismiss, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [at, hide])

  if (!at) return null

  const choose = (action: MenuAction) => {
    hide()
    action.run()
  }

  const step = (direction: 1 | -1) => {
    const reachable = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry !== SEPARATOR && !entry.disabled)
    if (reachable.length === 0) return

    const cursor = reachable.findIndex((candidate) => candidate.index === active)
    const next = reachable[(cursor + direction + reachable.length) % reachable.length]
    if (next) setActive(next.index)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      hide()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      step(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const entry = entries[active]
      if (entry && entry !== SEPARATOR && !entry.disabled) {
        event.preventDefault()
        choose(entry)
      }
    }
  }

  return (
    <div
      ref={surface}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // The menu owns its own right-click too, or the one underneath reopens.
      onContextMenu={(event) => event.preventDefault()}
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 min-w-[184px] rounded-panel border border-line-strong bg-surface py-1 shadow-lift outline-none select-none"
    >
      {entries.map((entry, index) =>
        entry === SEPARATOR ? (
          <div key={index} className="my-1 h-px bg-line" role="separator" />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            // On the press, the way a system menu answers, rather than waiting
            // for the release somewhere else to make it a click.
            onMouseDown={() => {
              if (!entry.disabled) choose(entry)
            }}
            onMouseEnter={() => setActive(index)}
            className={[
              'flex w-full items-center gap-2.5 px-2.5 py-[5px] text-left text-[12.5px] whitespace-nowrap',
              entry.disabled
                ? 'cursor-default text-faint/60'
                : entry.danger
                  ? 'text-danger'
                  : 'text-text',
              !entry.disabled && index === active
                ? entry.danger
                  ? 'bg-danger/12'
                  : 'bg-surface-2'
                : '',
            ].join(' ')}
          >
            {/* A fixed gutter whether or not this row has an icon, so labels
                line up the way they do in a system menu. */}
            <span className="flex w-[14px] shrink-0 justify-center">
              {entry.icon && <entry.icon size={13} strokeWidth={2} aria-hidden="true" />}
            </span>
            {entry.label}
          </button>
        ),
      )}
    </div>
  )
}

/** Re-exported so a caller writes one import to describe a menu. */
export type { MenuEntry }

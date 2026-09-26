import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check } from 'lucide-react'

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
  const owner = useMenu((state) => state.owner)
  const minWidth = useMenu((state) => state.minWidth)
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
    setActive(
      entries.findIndex((entry) => entry !== SEPARATOR && entry.selected && !entry.disabled),
    )
    element.focus()

    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [at, entries])

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
    const next =
      cursor < 0
        ? direction === 1
          ? reachable[0]
          : reachable.at(-1)
        : reachable[(cursor + direction + reachable.length) % reachable.length]
    if (next) setActive(next.index)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      hide()
      return
    }
    if (event.key === 'Tab') {
      hide()
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const reachable = entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry !== SEPARATOR && !entry.disabled)
      const next = event.key === 'Home' ? reachable[0] : reachable.at(-1)
      if (next) setActive(next.index)
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
      id={owner ? `${owner}-menu` : undefined}
      aria-activedescendant={active >= 0 ? `${owner ?? 'context-menu'}-item-${active}` : undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // The menu owns its own right-click too, or the one underneath reopens.
      onContextMenu={(event) => event.preventDefault()}
      style={{ left: position.x, top: position.y, minWidth: minWidth ?? undefined }}
      className={[
        'menu-surface fixed z-50 outline-none select-none',
        owner ? 'menu-surface--dropdown' : '',
      ].join(' ')}
    >
      {entries.map((entry, index) =>
        entry === SEPARATOR ? (
          <div key={index} className="my-1 h-px bg-line" role="separator" />
        ) : (
          <button
            key={index}
            id={`${owner ?? 'context-menu'}-item-${index}`}
            type="button"
            role={entry.selected === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={entry.selected === undefined ? undefined : entry.selected}
            data-selected={entry.selected || undefined}
            disabled={entry.disabled}
            // Standard activation supports assistive-technology clicks and
            // never executes an action when the user right-clicks an item.
            tabIndex={-1}
            onClick={() => {
              if (!entry.disabled) choose(entry)
            }}
            onMouseEnter={() => setActive(index)}
            className={[
              'menu-item',
              entry.disabled ? 'menu-item--disabled' : entry.danger ? 'menu-item--danger' : '',
              entry.selected ? 'menu-item--selected' : '',
              !entry.disabled && index === active
                ? entry.danger
                  ? 'menu-item--danger-active'
                  : 'menu-item--active'
                : '',
            ].join(' ')}
          >
            {/* A fixed gutter whether or not this row has an icon, so labels
                line up the way they do in a system menu. */}
            <span className="menu-item__indicator">
              {entry.selected ? (
                <Check size={18} strokeWidth={2.2} aria-hidden="true" />
              ) : (
                entry.icon && <entry.icon size={14} strokeWidth={2} aria-hidden="true" />
              )}
            </span>
            <span className="menu-item__label">{entry.label}</span>
          </button>
        ),
      )}
    </div>
  )
}

/** Re-exported so a caller writes one import to describe a menu. */
export type { MenuEntry }

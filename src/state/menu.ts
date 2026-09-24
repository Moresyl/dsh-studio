/**
 * The one context menu the window has, and where it currently is.
 *
 * A menu per component would mean four implementations of the same escape key,
 * so the menu is a single host at the root and everything else only describes
 * what it should contain. Which also guarantees the thing every desktop user
 * takes for granted: opening one menu closes the other.
 */
import type { MouseEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { create } from 'zustand'

export interface MenuAction {
  label: string
  icon?: LucideIcon
  /** Marks the current value in menus that choose exactly one option. */
  selected?: boolean
  /** Present but not available — greyed rather than missing, so the menu keeps its shape. */
  disabled?: boolean
  /** Destructive, and coloured like it. */
  danger?: boolean
  run: () => void
}

/** A rule between groups of actions. */
export const SEPARATOR = 'separator' as const

export type MenuEntry = MenuAction | typeof SEPARATOR

interface MenuState {
  /** Null when nothing is open, which is nearly always. */
  at: { x: number; y: number } | null
  entries: MenuEntry[]
  owner: string | null
  minWidth: number | null
  show: (
    x: number,
    y: number,
    entries: MenuEntry[],
    options?: { owner?: string; minWidth?: number },
  ) => void
  hide: () => void
}

export const useMenu = create<MenuState>((set) => ({
  at: null,
  entries: [],
  owner: null,
  minWidth: null,
  show: (x, y, entries, options) =>
    set({
      at: { x, y },
      entries,
      owner: options?.owner ?? null,
      minWidth: options?.minWidth ?? null,
    }),
  hide: () => set({ at: null, entries: [], owner: null, minWidth: null }),
}))

/**
 * Build the right-click handler for a set of actions.
 *
 * Written as `onContextMenu={contextMenu([…])}` at the call site, which keeps
 * the description of the menu next to the thing it belongs to. Pass a function
 * instead of an array when an entry depends on something that changes without a
 * render — a text selection, most of all, which is read from the document and
 * not from state.
 */
export const contextMenu =
  (source: MenuEntry[] | (() => MenuEntry[])) =>
  (event: MouseEvent): void => {
    // Ours instead of the webview's, everywhere — including over selectable
    // text, where the browser would otherwise offer its own.
    event.preventDefault()
    event.stopPropagation()

    const entries = typeof source === 'function' ? source() : source
    if (entries.length > 0) useMenu.getState().show(event.clientX, event.clientY, entries)
  }

/** What the user has highlighted, if it is worth offering to copy. */
export const selectedText = (): string => window.getSelection()?.toString() ?? ''

/**
 * Whether the command palette is up.
 *
 * A store rather than a flag in the window component, for the same reason the
 * context menu is one: the key that opens it is listened for at the window, the
 * thing that draws it sits at the root of the layout, and anything else that
 * wants to offer a way in — a button in a strip, an empty state saying "try
 * Ctrl+K" — should be able to open it without a callback threaded down to it.
 */
import { create } from 'zustand'

interface PaletteState {
  open: boolean
  show: () => void
  hide: () => void
  toggle: () => void
}

export const usePalette = create<PaletteState>((set, get) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
  toggle: () => set({ open: !get().open }),
}))

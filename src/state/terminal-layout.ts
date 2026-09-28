import { create } from 'zustand'
import { readPreference, savePreference } from '@/lib/preferences'

export type TerminalLayout = 'single' | 'columns' | 'rows' | 'grid'

const KEY = 'dsh-studio:terminal-layout:v1'

export function decodeTerminalLayout(value: unknown): TerminalLayout {
  return value === 'columns' || value === 'rows' || value === 'grid' ? value : 'single'
}

/** Remember presentation only. Restoring a layout must never launch a shell. */
export const useTerminalLayout = create<{
  layout: TerminalLayout
  choose: (value: string) => void
}>((set) => ({
  layout: decodeTerminalLayout(readPreference(KEY)),
  choose: (value) => {
    const layout = decodeTerminalLayout(value)
    set({ layout })
    savePreference(KEY, layout)
  },
}))

/** Stable groups keep clicking a visible pane from rearranging its neighbours. */
export function visibleTerminalIds(
  ids: readonly string[],
  active: string | null,
  layout: TerminalLayout,
): string[] {
  const capacity = layout === 'single' ? 1 : layout === 'grid' ? 4 : 2
  const index = Math.max(0, active === null ? 0 : ids.indexOf(active))
  const start = Math.floor(index / capacity) * capacity
  return ids.slice(start, start + capacity)
}

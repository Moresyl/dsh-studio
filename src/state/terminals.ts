/**
 * The shells this window has open, and which one is showing.
 *
 * The store holds the tabs; `lib/screen` holds the emulators. The split is not
 * cosmetic — a terminal's transcript has to outlive the pane that draws it, and
 * putting it in React state would tie a shell's scrollback to whether the user
 * is currently looking at it. So this module knows ids and exit codes, and the
 * other one knows pixels. The dependency points this way only.
 *
 * Opening is the one action that hands a screen in rather than making one here.
 * A shell has to be started at the size of the box that will show it, and only
 * the emulator can measure that — so the pane makes the screen, this store makes
 * the session, and the order in between is what keeps the first prompt.
 */
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import type { TerminalExit, TerminalSession } from '@/lib/ipc'
import * as screens from '@/lib/screen'
import type { Screen } from '@/lib/screen'
import { reportFailure } from '@/state/failure'

/** One tab: a shell, and how it ended if it has. */
export interface TerminalTab extends TerminalSession {
  /** Null while it is still running. */
  exit: { code: number | null } | null
}

interface TerminalStore {
  tabs: TerminalTab[]
  /** The tab on screen, or null when there are none. */
  active: string | null
  /** A shell is being started. */
  opening: boolean
  error: string | null

  /** Find the shells this window already owns — after a reload, say. */
  sync: () => Promise<void>
  open: (screen: Screen, rows: number, cols: number) => Promise<void>
  /** End a running shell, or clear away a tab whose shell has finished. */
  close: (id: string) => Promise<void>
  select: (id: string) => void
  dismiss: () => void
}

/**
 * Shells the user asked to close, waiting for their exit to come back.
 *
 * Killing a shell is itself a bad exit — a signal, or whatever code the shell
 * reports on the way down — and the rule below keeps bad exits on screen so the
 * last lines can be read. Without this set, a tab the user closed would come
 * straight back as a transcript nobody asked for.
 *
 * Not in the store: nothing renders it, and a set that lives for the few
 * milliseconds between a kill and its exit event has no business causing a draw.
 */
const closing = new Set<string>()

/** The tab to show once `id` is gone: the one after it, else the one before. */
function neighbour(tabs: TerminalTab[], id: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return null
  return (tabs[index + 1] ?? tabs[index - 1])?.id ?? null
}

export const useTerminals = create<TerminalStore>((set, get) => ({
  tabs: [],
  active: null,
  opening: false,
  error: null,

  sync: async () => {
    try {
      const sessions = await ipc.terminalList()
      set((state) => {
        // What Rust lists is what is *running*, so absence from it is not
        // evidence a tab never existed: a finished tab is a transcript someone
        // may be reading, and it stays. A tab still marked as running that is
        // not in the answer is the other way round — its shell is gone and its
        // exit was never heard, so there is nothing left to keep.
        const running = new Set(sessions.map((session) => session.id))
        const kept = state.tabs.filter((tab) => running.has(tab.id) || tab.exit !== null)

        const known = new Set(state.tabs.map((tab) => tab.id))
        const found = sessions
          .filter((session) => !known.has(session.id))
          .map((session) => ({ ...session, exit: null }))

        const tabs = [...kept, ...found]
        const active = tabs.some((tab) => tab.id === state.active)
          ? state.active
          : (tabs[0]?.id ?? null)

        return { tabs, active }
      })
    } catch (cause) {
      set({ error: describe(cause) })
    }
  },

  open: async (screen, rows, cols) => {
    // The button's render-time `opening` value can still be false for a second
    // click before React paints the first state change. The second emulator has
    // already been created by then, so refusing the request must dispose it or
    // it remains as an unowned canvas over the active terminal.
    if (get().opening) {
      screens.discard(screen)
      return
    }
    set({ opening: true, error: null })
    let session: TerminalSession | null = null
    try {
      const opened = await ipc.terminalOpen(rows, cols)
      session = opened
      // Before the tab exists, on purpose. The pty is read from the moment it is
      // created, so a shell that prints its prompt immediately can beat its own
      // id back across the boundary — and this is the line that decides whether
      // that prompt lands in the terminal or in the buffer waiting for it.
      screens.adopt(opened.id, screen)
      set((state) => ({ tabs: [...state.tabs, { ...opened, exit: null }], active: opened.id }))
    } catch (cause) {
      if (session) {
        // `adopt` registers the screen before wiring its input and resize
        // handlers. If either registration fails, both halves now exist but no
        // tab owns them. Roll them both back; leaving the PTY alive would keep a
        // hidden shell running until the whole application exits.
        screens.dispose(session.id)
        try {
          await ipc.terminalClose(session.id)
        } catch {
          // Keep the error that prevented the terminal from opening. A cleanup
          // failure is secondary and the Rust supervisor will still reap the
          // child when Studio exits.
        }
      } else {
        screens.discard(screen)
      }
      set({ error: reportFailure(cause) })
    } finally {
      set({ opening: false })
    }
  },

  close: async (id) => {
    // Already finished: there is nothing to kill, and the click means "clear
    // this away". Doing it here rather than making the pane ask which kind of
    // tab it is holding.
    if (get().tabs.find((tab) => tab.id === id)?.exit) {
      forget(id)
      return
    }

    // A second click can arrive while the first kill is in flight. Sending the
    // same kill again races the exit event and can turn a successful close into
    // a visible "terminal is no longer open" error.
    if (closing.has(id)) return

    closing.add(id)
    try {
      await ipc.terminalClose(id)
    } catch (cause) {
      closing.delete(id)
      set({ error: reportFailure(cause) })
    }
  },

  select: (id) => set({ active: id }),

  dismiss: () => set({ error: null }),
}))

/** Drop a tab and end its emulator for good. */
function forget(id: string): void {
  closing.delete(id)
  screens.dispose(id)
  useTerminals.setState((state) => ({
    tabs: state.tabs.filter((tab) => tab.id !== id),
    active: state.active === id ? neighbour(state.tabs, id) : state.active,
  }))
}

/**
 * What to do with a shell that has finished.
 *
 * A clean exit is a shell someone typed `exit` into, and its tab goes: leaving
 * it would make closing a terminal a two-step job. Anything else stays, because
 * a shell that fell over has its reason in its last few lines, and a tab that
 * vanishes takes the reason with it.
 */
function retire(exit: TerminalExit): void {
  if (exit.code === 0 || closing.has(exit.id)) {
    forget(exit.id)
    return
  }

  screens.retire(exit.id, exit.code)
  useTerminals.setState((state) => ({
    tabs: state.tabs.map((tab) =>
      tab.id === exit.id ? { ...tab, exit: { code: exit.code } } : tab,
    ),
  }))
}

/**
 * Follow every shell for the lifetime of the window.
 *
 * From the window rather than from the pane, for the reason the pane exists at
 * all: output has to keep arriving while the user is reading something else, and
 * a shell that fails in the background has to be able to say so.
 */
export async function subscribeToTerminals(): Promise<() => void> {
  screens.reportProblemsTo((cause) => useTerminals.setState({ error: describe(cause) }))
  const unfollowTheme = screens.followTheme()

  const [unlistenOutput, unlistenExit] = await Promise.all([
    ipc.onTerminalOutput((output) => screens.write(output.id, output.data)),
    ipc.onTerminalExit(retire),
  ])

  // Shells outlive the page in development, where a reload rebuilds every
  // emulator but kills nothing.
  void useTerminals.getState().sync()

  return () => {
    unlistenOutput()
    unlistenExit()
    unfollowTheme()
  }
}

/** How many shells are still running, for the rail's badge. */
export const runningCount = (tabs: TerminalTab[]): number =>
  tabs.reduce((total, tab) => total + (tab.exit === null ? 1 : 0), 0)

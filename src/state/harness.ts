/**
 * One store for everything the supervisor tells us.
 *
 * The Rust side is the single source of truth: this holds the last thing it
 * said and never guesses ahead of it, so the UI cannot show a state the process
 * is not actually in.
 */
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import type { Environment, HarnessEvent, LogLine, Status } from '@/lib/ipc'

/** Matches the ring the supervisor keeps, so scrollback agrees on both sides. */
const MAX_LINES = 2000

/**
 * npm logs one line per package it resolves, and never a total.
 *
 * Counting those lines is the only progress signal it actually offers, so that
 * is what gets shown — a number that goes up, not a bar pretending to know how
 * far along a multi-minute install is.
 */
const NPM_PACKAGE_LINE = /^npm http (?:fetch|cache) /

interface HarnessStore {
  environment: Environment | null
  status: Status
  lines: LogLine[]
  /** A start or stop request is in flight. */
  busy: boolean
  /** An install is running. Separate from `busy`: it takes minutes, not ms. */
  installing: boolean
  /** Packages seen during the current install. */
  installProgress: number
  /** Last request failure, cleared when the next one begins. */
  error: string | null

  inspect: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  install: () => Promise<void>
  /** Empty the visible scrollback. The supervisor's own ring is untouched. */
  clear: () => void
  /** Apply one event from the Rust side. */
  apply: (event: HarnessEvent) => void
}

export const useHarness = create<HarnessStore>((set, get) => ({
  environment: null,
  status: { phase: 'stopped' },
  lines: [],
  busy: false,
  installing: false,
  installProgress: 0,
  error: null,

  inspect: async () => {
    const [environment, status, lines] = await Promise.all([
      ipc.environment(),
      ipc.status(),
      ipc.log(),
    ])
    set({ environment, status, lines })
  },

  start: async () => {
    if (get().busy) return
    set({ busy: true, error: null })
    try {
      await ipc.start()
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ busy: false })
    }
  },

  stop: async () => {
    set({ busy: true, error: null })
    try {
      await ipc.stop()
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ busy: false })
    }
  },

  install: async () => {
    if (get().installing) return
    set({ installing: true, installProgress: 0, error: null })
    try {
      await ipc.install()
      // The check card is driven by what is on disk, so re-read it.
      await get().inspect()
    } catch (cause) {
      set({ error: describe(cause) })
    } finally {
      set({ installing: false })
    }
  },

  // Only what is on screen: asking the supervisor to forget its buffer would
  // throw away the evidence of a crash for everyone, including a later report.
  clear: () => set({ lines: [] }),

  apply: (event) => {
    if (event.kind === 'log') {
      const { stream, line } = event
      set((state) => ({
        lines:
          state.lines.length >= MAX_LINES
            ? [...state.lines.slice(state.lines.length - MAX_LINES + 1), { stream, line }]
            : [...state.lines, { stream, line }],
        installProgress:
          state.installing && NPM_PACKAGE_LINE.test(line)
            ? state.installProgress + 1
            : state.installProgress,
      }))
      return
    }

    const { kind: _kind, ...status } = event
    set({ status: status as Status })
  },
}))

/** Wire the store to the Rust event stream for the lifetime of the app. */
export const subscribeToHarness = (): Promise<() => void> =>
  ipc.onHarnessEvent((event) => useHarness.getState().apply(event))

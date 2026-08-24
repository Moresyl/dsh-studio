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
import type { Environment, HarnessEvent, LogLine, NodeProgress, Status } from '@/lib/ipc'
import { reportFailure } from '@/state/failure'

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
  /** A Node runtime is being downloaded and unpacked. */
  provisioningNode: boolean
  /** Last thing the Node install said, or null when none is running. */
  nodeProgress: NodeProgress | null
  /** Last request failure, cleared when the next one begins. */
  error: string | null

  inspect: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  install: () => Promise<void>
  /** Fetch a Node runtime for a machine that has none. */
  provisionNode: () => Promise<void>
  /** Use one of the discovered supported Node runtimes for the next start. */
  selectNode: (path: string) => Promise<void>
  /** Empty the visible scrollback. The supervisor's own ring is untouched. */
  clear: () => void
  /** Apply one event from the Rust side. */
  apply: (event: HarnessEvent) => void
  /** Apply one progress report from an in-app Node install. */
  applyNodeProgress: (progress: NodeProgress) => void
}

/** Whether one operation that changes the supervised runtime is still active. */
const occupied = (state: HarnessStore): boolean =>
  state.busy || state.installing || state.provisioningNode

export const useHarness = create<HarnessStore>((set, get) => ({
  environment: null,
  status: { phase: 'stopped' },
  lines: [],
  busy: false,
  installing: false,
  installProgress: 0,
  provisioningNode: false,
  nodeProgress: null,
  error: null,

  inspect: async () => {
    set({ error: null })
    try {
      const [environment, status, lines] = await Promise.all([
        ipc.environment(),
        ipc.status(),
        ipc.log(),
      ])
      set({ environment, status, lines })
    } catch (cause) {
      // Re-check is a visible action as well as the first startup probe. Keep a
      // reason beside the controls that requested it. Reject as well so a
      // caller coordinating a workspace or install does not continue after a
      // refresh that never actually landed.
      set({ error: describe(cause) })
      throw cause
    }
  },

  start: async () => {
    if (occupied(get())) return
    set({ busy: true, error: null })
    try {
      await ipc.start()
    } catch (cause) {
      set({ error: reportFailure(cause) })
    } finally {
      set({ busy: false })
    }
  },

  stop: async () => {
    if (occupied(get())) return
    set({ busy: true, error: null })
    try {
      await ipc.stop()
    } catch (cause) {
      set({ error: reportFailure(cause) })
    } finally {
      set({ busy: false })
    }
  },

  install: async () => {
    if (occupied(get())) return
    set({ installing: true, installProgress: 0, error: null })
    try {
      await ipc.install()
      // The check card is driven by what is on disk, so re-read it.
      await get().inspect()
    } catch (cause) {
      set({ error: reportFailure(cause) })
    } finally {
      set({ installing: false })
    }
  },

  provisionNode: async () => {
    if (occupied(get())) return
    set({ provisioningNode: true, nodeProgress: null, error: null })
    try {
      await ipc.nodeProvision()
      // The runtime now exists on disk; the check card reads it from there.
      await get().inspect()
    } catch (cause) {
      set({ error: reportFailure(cause), nodeProgress: null })
    } finally {
      set({ provisioningNode: false })
    }
  },

  selectNode: async (path) => {
    if (occupied(get())) return
    set({ busy: true, error: null })
    try {
      await ipc.nodeSelect(path)
      await get().inspect()
    } catch (cause) {
      set({ error: reportFailure(cause) })
    } finally {
      set({ busy: false })
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

  // Held rather than interpreted: the phase names are the Rust enum's own, so
  // the card describes what the installer is doing and not what we assume next.
  applyNodeProgress: (progress) => set({ nodeProgress: progress }),
}))

/** Wire the store to the Rust event streams for the lifetime of the app. */
export const subscribeToHarness = async (): Promise<() => void> => {
  const [harness, node] = await Promise.all([
    ipc.onHarnessEvent((event) => useHarness.getState().apply(event)),
    ipc.onNodeProgress((progress) => useHarness.getState().applyNodeProgress(progress)),
  ])
  return () => {
    harness()
    node()
  }
}

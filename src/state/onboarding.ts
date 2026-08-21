/**
 * Whether this launch has to show someone around.
 *
 * A guide, not a mode. The alternative — a simple mode and an advanced one —
 * asks a question nobody can answer before they have used the application, and
 * then makes them go and find the switch again once they can. What is actually
 * different about a first run is that nothing is installed and nothing has been
 * chosen yet, and that is a sequence rather than a preference: three steps, once,
 * and then the application they were leading up to.
 *
 * So there is no setting here and nothing to turn back on, because there is
 * nothing in the guide that is not also in the app. The checks are the console's
 * own checks, the agent picker is on the console too, and the last step is the
 * button that was always there.
 */
import { create } from 'zustand'

import type { Environment } from '@/lib/ipc'

/** How many steps there are, which is also what the last index is measured from. */
export const STEPS = 3

/**
 * Bumped when the guide changes enough that someone who has seen it should see
 * it again. The harness stamps its own welcome notice the same way, which is
 * where the shape comes from.
 */
const VERSION = '1'

/** Namespaced, because a webview's storage is shared with whatever it hosts. */
const KEY = 'dsh-studio.onboarding'

/**
 * `unknown` until the machine has been looked at.
 *
 * A third state and not a boolean, because the answer depends on a filesystem
 * probe: guessing `guiding` and correcting it would show a guide to someone who
 * did not need one, and guessing `done` would flash the workspace at someone who
 * did.
 */
type Stage = 'unknown' | 'guiding' | 'done'

/** Storage can throw rather than merely be empty, and a guide is not worth failing over. */
function seen(): boolean {
  try {
    return window.localStorage.getItem(KEY) === VERSION
  } catch {
    return false
  }
}

function remember(): void {
  try {
    window.localStorage.setItem(KEY, VERSION)
  } catch {
    // Costs one more guide at the next start, which is worth less than a window
    // that refused to open because it could not write a flag.
  }
}

interface OnboardingState {
  stage: Stage
  /** Zero-based, so it indexes the step list directly. */
  step: number

  /** Settle whether this launch is guided, from what the machine turned out to have. */
  consider: (environment: Environment | null) => void
  go: (step: number) => void
  /** Finished or skipped; either way it does not come back. */
  finish: () => void
}

export const useOnboarding = create<OnboardingState>((set, get) => ({
  stage: 'unknown',
  step: 0,

  consider: (environment) => {
    // Asked once. The first step installs the harness, and re-deciding after that
    // would close the guide from underneath the person following it.
    if (get().stage !== 'unknown') return

    // A machine with the harness already on it has been set up before, whatever
    // this window remembers — an install that predates the guide, a profile
    // carried across, application data that was cleared. Walking someone through
    // installing what they already have is how a first run becomes a thing to
    // click past. A probe that came back with nothing is not a machine to guide
    // anyone through either; the console pane is where that gets explained.
    const settled =
      seen() ||
      environment === null ||
      (environment.harnessInstalled &&
        environment.harnessCompatible &&
        environment.workspaceAdmission.state !== 'blocked')
    if (settled) remember()

    set({ stage: settled ? 'done' : 'guiding' })
  },

  go: (step) => set({ step: Math.min(Math.max(step, 0), STEPS - 1) }),

  finish: () => {
    remember()
    set({ stage: 'done' })
  },
}))

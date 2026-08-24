/**
 * Every profile on the machine, and which one this window is pointed at.
 *
 * The roster always comes back from the Rust side rather than being patched
 * locally: a profile is a directory, and half of what is shown about one — how
 * many plugins are in it, whether it can serve this window at all — is read off
 * disk. A store that edited its own copy after a rename would be showing counts
 * for a directory it had stopped looking at.
 *
 * This is also the one file in `src/state` that reaches into another store, and
 * the reason is worth stating: the plugin panel is a panel *of* one profile, so
 * a profile that is renamed, deleted or switched away from changes what that
 * panel is looking at. Doing it here means it happens once, for every change,
 * instead of in each component that offers one.
 */
import { create } from 'zustand'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'
import { t } from '@/lib/i18n'
import type { Comparison, Declaration, Profile, Roster } from '@/lib/ipc'
import { ask } from '@/state/dialog'
import { useHarness } from '@/state/harness'
import { reportFailure } from '@/state/failure'
import { usePlugins } from '@/state/plugins'

interface ProfileStore {
  /** Null until the first read lands. */
  roster: Roster | null
  /** Which profile a change is running against, or null when idle. */
  working: string | null
  /** Two profiles, side by side. Null until a comparison is asked for. */
  comparison: Comparison | null
  comparing: boolean
  /** Last thing that went well and is worth a line — an export, mostly. */
  note: string | null
  error: string | null

  refresh: () => Promise<void>
  /** Record the choice. Coordinated by `switchProfile`, not called on its own. */
  select: (name: string) => Promise<boolean>
  create: (name: string) => Promise<boolean>
  duplicate: (source: string, name: string) => Promise<boolean>
  rename: (from: string, to: string) => Promise<boolean>
  remove: (name: string) => Promise<boolean>
  /** Write a profile out to a path the user has already picked. */
  save: (name: string, path: string) => Promise<boolean>
  /** Read an exported profile, so its name can be offered before anything is written. */
  read: (path: string) => Promise<Declaration | null>
  load: (path: string, name: string) => Promise<boolean>
  compare: (left: string, right: string) => Promise<void>
  /** Drop the error and the note, so a reopened manager starts clean. */
  settle: () => void
}

type Write = (partial: Partial<ProfileStore>) => void

/** A profile mutation invalidates any comparison still being calculated. */
let comparisonGeneration = 0

/**
 * Run one change and take the roster it answers with.
 *
 * All six changes are the same shape — one at a time, the reply replaces the
 * roster, a failure is a sentence rather than a thrown value — and what they
 * return is whether the form that asked for it may close.
 */
const change = async (
  set: Write,
  get: () => ProfileStore,
  subject: string,
  run: () => Promise<Roster>,
): Promise<boolean> => {
  // Every one of these writes the profiles directory, and two package managers
  // in there at once is how a half-installed profile happens.
  if (get().working !== null) return false

  comparisonGeneration += 1
  const before = get().roster
  set({ working: subject, comparison: null, comparing: false, error: null, note: null })

  try {
    const roster = await run()
    // A comparison is a snapshot of two profiles, and one of them may have just
    // been renamed, emptied or deleted.
    set({ roster, comparison: null })
    if (hostedMoved(before, roster)) resubject()
    // The directory this read is a reading of is the same directory every other
    // window is reading. Told rather than left to notice: a rename is a name
    // that no longer exists, and a window still offering it would be offering a
    // switch that fails.
    void ipc.announce('profiles')
    return true
  } catch (cause) {
    set({ error: reportFailure(cause) })
    return false
  } finally {
    set({ working: null })
  }
}

export const useProfiles = create<ProfileStore>((set, get) => ({
  roster: null,
  working: null,
  comparison: null,
  comparing: false,
  note: null,
  error: null,

  refresh: async () => {
    if (get().working !== null) return
    try {
      set({ roster: await ipc.profileRoster() })
    } catch (cause) {
      set({ error: describe(cause) })
    }
  },

  select: (name) => change(set, get, name, () => ipc.profileSelect(name)),

  create: (name) => change(set, get, name, () => ipc.profileCreate(name)),

  duplicate: (source, name) => change(set, get, name, () => ipc.profileDuplicate(source, name)),

  rename: (from, to) => change(set, get, from, () => ipc.profileRename(from, to)),

  remove: (name) => change(set, get, name, () => ipc.profileRemove(name)),

  save: async (name, path) => {
    set({ error: null, note: null })
    try {
      await ipc.profileExport(name, path)
      set({ note: t('profile.exported', { path }) })
      return true
    } catch (cause) {
      set({ error: reportFailure(cause) })
      return false
    }
  },

  read: async (path) => {
    set({ error: null, note: null })
    try {
      return await ipc.profileDeclaration(path)
    } catch (cause) {
      set({ error: reportFailure(cause) })
      return null
    }
  },

  load: (path, name) => change(set, get, name, () => ipc.profileImport(path, name)),

  compare: async (left, right) => {
    if (get().working !== null) return
    const mine = ++comparisonGeneration
    set({ comparing: true, error: null })
    try {
      const comparison = await ipc.profileCompare(left, right)
      if (mine === comparisonGeneration) set({ comparison })
    } catch (cause) {
      if (mine === comparisonGeneration) {
        set({ comparison: null, error: reportFailure(cause) })
      }
    } finally {
      if (mine === comparisonGeneration) set({ comparing: false })
    }
  },

  settle: () => set({ error: null, note: null }),
}))

/**
 * Choose the profile this window works in.
 *
 * Two things follow from a choice, and only one of them is a file write:
 *
 *  1. The selection is recorded, so the next harness start boots that stack —
 *     and the plugin panel follows it, which `change` above takes care of.
 *  2. A harness that is already running is still running the old stack, and will
 *     keep doing so: the layer list is composed at boot, and ending live
 *     sessions is the user's call. So the restart is offered rather than taken.
 */
export async function switchProfile(name: string): Promise<void> {
  const store = useProfiles.getState()
  if (store.working !== null || store.roster?.selected === name) return
  if (!(await store.select(name))) return

  const { phase } = useHarness.getState().status
  if (phase === 'stopped' || phase === 'failed') return

  const taken = await ask({
    title: t('profile.restartTitle'),
    body: t('profile.restartBody'),
    subject: name,
    confirm: t('profile.restartConfirm'),
    tone: 'brand',
  })
  if (!taken) return

  await useHarness.getState().stop()
  await useHarness.getState().start()
}

/** The profile the window is pointed at, as the roster describes it. */
export const hostedProfile = (roster: Roster | null): Profile | null =>
  roster?.profiles.find((profile) => profile.name === roster.selected) ?? null

/**
 * Whether a name is one the shell will make a profile under.
 *
 * Mirrors `is_new_name` in `src-tauri/src/profiles/mod.rs`, which stays the
 * authority — nothing is created on the strength of this. It is here so a form
 * can grey its own button out instead of spending a round trip to be told that a
 * capital letter is not allowed, and it is deliberately the same rule rather
 * than a looser one: a field that accepts what the next step refuses is worse
 * than no check at all.
 */
export const isNewProfileName = (name: string): boolean =>
  /^[a-z0-9][a-z0-9_-]*$/.test(name) && name.length <= 64 && name !== 'node_modules'

/**
 * Whether the hosted profile is a different one, or the same one somewhere else.
 *
 * Both cases mean the plugin panel is reading a manifest it should stop reading:
 * the first because the subject changed, the second because a rename moved the
 * directory out from under it.
 */
const hostedMoved = (before: Roster | null, after: Roster): boolean => {
  const was = hostedProfile(before)
  const now = hostedProfile(after)
  return was?.name !== now?.name || was?.dir !== now?.dir
}

/** Tell the plugin panel to read its profile again. */
const resubject = (): void => void usePlugins.getState().refresh()

/**
 * Follow what the other windows do to the profiles.
 *
 * Subscribed for the lifetime of the window rather than by the manager that
 * shows the roster, because the chip in the title bar shows it too and that one
 * is never closed. Both readings are redone, for the reason at the top of this
 * file: the roster counts what is installed in each profile, so installing a
 * plugin in another window moves a number here as well.
 *
 * The window that made the change hears its own announcement and rereads what
 * it has just been handed. That is one directory listing per change made by a
 * person, and it is what keeps this a signal rather than a second copy of the
 * roster travelling between windows.
 */
export const subscribeToProfiles = (): Promise<() => void> =>
  ipc.onSharedChange((subject) => {
    if (subject !== 'profiles') return
    void useProfiles.getState().refresh()
    resubject()
  })

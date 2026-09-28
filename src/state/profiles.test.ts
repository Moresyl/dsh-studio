import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Comparison, Profile, Roster } from '@/lib/ipc'
import * as ipc from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
import { useHarness } from '@/state/harness'
import { usePlugins } from '@/state/plugins'
import {
  hostedProfile,
  isNewProfileName,
  subscribeToProfiles,
  switchProfile,
  useProfiles,
} from '@/state/profiles'

// The command surface only exists inside a real window, and every rule under
// test is about what the store does with the answer rather than about the call.
vi.mock('@/lib/ipc')

const profile = (name: string): Profile => ({
  name,
  dir: `D:\\dsh\\profiles\\${name}`,
  initialized: true,
  shipped: false,
  servesWindow: true,
  plugins: 0,
  disabled: 0,
})

const roster = (selected: string, ...names: string[]): Roster => ({
  profiles: names.map(profile),
  selected,
  root: 'D:\\dsh\\profiles',
})

/** A reply the test decides the timing of, which is how "in flight" is staged. */
const gate = <T>() => {
  let settle: (value: T) => void = () => {}
  const reply = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { reply, settle: (value: T) => settle(value) }
}

/** Answer the restart question the way somebody at the window would. */
const answer = async (taken: boolean): Promise<void> => {
  await vi.waitFor(() => expect(useDialog.getState().pending).not.toBeNull())
  useDialog.getState().settle(taken)
}

const serving = () =>
  useHarness.setState({ status: { phase: 'ready', origin: 'http://127.0.0.1:8100', pid: 4242 } })

beforeEach(() => {
  vi.resetAllMocks()
  useDialog.setState({ pending: null })
  useProfiles.setState({
    roster: roster('web', 'web', 'lab'),
    working: null,
    comparison: null,
    comparing: false,
    note: null,
    error: null,
  })
  useHarness.setState({
    status: { phase: 'stopped' },
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
  })
  usePlugins.setState({ refresh: vi.fn(async () => {}) })
})

describe('a change to the profiles directory', () => {
  it('does not restore an old roster after a mutation completes', async () => {
    const pending = gate<Roster>()
    vi.mocked(ipc.profileRoster).mockReturnValueOnce(pending.reply)
    vi.mocked(ipc.profileRename).mockResolvedValueOnce(roster('web', 'web', 'renamed'))
    const refreshing = useProfiles.getState().refresh()
    await useProfiles.getState().rename('lab', 'renamed')
    pending.settle(roster('web', 'web', 'lab'))
    await refreshing
    expect(useProfiles.getState().roster?.profiles.map((item) => item.name)).toEqual([
      'web',
      'renamed',
    ])
  })

  it('keeps only the newest overlapping roster refresh', async () => {
    const pending = gate<Roster>()
    vi.mocked(ipc.profileRoster)
      .mockReturnValueOnce(pending.reply)
      .mockResolvedValueOnce(roster('lab', 'web', 'lab'))
    const old = useProfiles.getState().refresh()
    await useProfiles.getState().refresh()
    pending.settle(roster('web', 'web', 'lab'))
    await old
    expect(useProfiles.getState().roster?.selected).toBe('lab')
  })

  it('drops stale refresh errors after a successful mutation and clears a recovered refresh', async () => {
    let reject!: (cause: Error) => void
    vi.mocked(ipc.profileRoster).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail
      }),
    )
    vi.mocked(ipc.profileRename).mockResolvedValueOnce(roster('web', 'web', 'renamed'))
    const old = useProfiles.getState().refresh()
    await useProfiles.getState().rename('lab', 'renamed')
    reject(new Error('obsolete read failed'))
    await old
    expect(useProfiles.getState().error).toBeNull()
    useProfiles.setState({ error: 'previous failure' })
    vi.mocked(ipc.profileRoster).mockResolvedValueOnce(roster('web', 'web', 'renamed'))
    await useProfiles.getState().refresh()
    expect(useProfiles.getState().error).toBeNull()
  })
  it('refuses a second one while the first is still running', async () => {
    const first = gate<Roster>()
    vi.mocked(ipc.profileCreate).mockReturnValueOnce(first.reply)

    const running = useProfiles.getState().create('bench')
    expect(useProfiles.getState().working).toBe('bench')

    // Two package managers in the same directory is how a half-installed
    // profile happens, so the second attempt is turned away rather than queued.
    expect(await useProfiles.getState().create('scratch')).toBe(false)
    expect(ipc.profileCreate).toHaveBeenCalledTimes(1)

    first.settle(roster('web', 'web', 'lab', 'bench'))
    expect(await running).toBe(true)
    expect(useProfiles.getState().working).toBeNull()
  })

  it('reports a refusal as the sentence it came back as', async () => {
    vi.mocked(ipc.profileRemove).mockRejectedValueOnce('the harness is running lab; stop it first')

    expect(await useProfiles.getState().remove('lab')).toBe(false)
    expect(useProfiles.getState().error).toBe('the harness is running lab; stop it first')
    // Nothing was written, so nothing about the roster may change.
    expect(useProfiles.getState().roster?.profiles).toHaveLength(2)
    expect(useProfiles.getState().working).toBeNull()
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'the harness is running lab; stop it first',
    })
  })

  it('drops the comparison on screen, which may have just lost a side', async () => {
    useProfiles.setState({
      comparison: { left: 'web', right: 'lab', rows: [], differences: 0 },
    })
    vi.mocked(ipc.profileRename).mockResolvedValueOnce(roster('web', 'web', 'bench'))

    expect(await useProfiles.getState().rename('lab', 'bench')).toBe(true)
    expect(useProfiles.getState().comparison).toBeNull()
  })

  it('does not restore a stale comparison after a profile changes', async () => {
    let finishCompare!: (answer: Comparison) => void
    vi.mocked(ipc.profileCompare).mockReturnValue(
      new Promise<Comparison>((resolve) => {
        finishCompare = resolve
      }),
    )
    vi.mocked(ipc.profileRename).mockResolvedValue(roster('web', 'web', 'bench'))

    const comparing = useProfiles.getState().compare('web', 'lab')
    await useProfiles.getState().rename('lab', 'bench')
    finishCompare({ left: 'web', right: 'lab', rows: [], differences: 0 })
    await comparing

    expect(useProfiles.getState().comparison).toBeNull()
    expect(useProfiles.getState().comparing).toBe(false)
  })

  it('does not refresh the roster during a profile write', async () => {
    const pending = gate<Roster>()
    vi.mocked(ipc.profileCreate).mockReturnValue(pending.reply)

    const creating = useProfiles.getState().create('bench')
    await useProfiles.getState().refresh()

    expect(ipc.profileRoster).not.toHaveBeenCalled()
    pending.settle(roster('web', 'web', 'lab', 'bench'))
    await creating
  })

  it('keeps a failed background roster refresh quiet', async () => {
    vi.mocked(ipc.profileRoster).mockRejectedValueOnce('profile directory unavailable')

    await useProfiles.getState().refresh()

    expect(useProfiles.getState().error).toBe('profile directory unavailable')
    expect(useDialog.getState().pending).toBeNull()
  })

  it('does not compare profiles while one of them is being changed', async () => {
    const pending = gate<Roster>()
    vi.mocked(ipc.profileCreate).mockReturnValue(pending.reply)

    const creating = useProfiles.getState().create('bench')
    await useProfiles.getState().compare('web', 'lab')

    expect(ipc.profileCompare).not.toHaveBeenCalled()
    pending.settle(roster('web', 'web', 'lab', 'bench'))
    await creating
  })
})

describe('the plugin panel, which is a panel of one profile', () => {
  it('is told to read again when the profile under it moves', async () => {
    vi.mocked(ipc.profileSelect).mockResolvedValueOnce(roster('lab', 'web', 'lab'))

    await useProfiles.getState().select('lab')
    expect(usePlugins.getState().refresh).toHaveBeenCalledTimes(1)
  })

  it('is left alone when the change was to some other profile', async () => {
    vi.mocked(ipc.profileCreate).mockResolvedValueOnce(roster('web', 'web', 'lab', 'bench'))

    await useProfiles.getState().create('bench')
    expect(usePlugins.getState().refresh).not.toHaveBeenCalled()
  })
})

describe('choosing the profile this window works in', () => {
  it('does nothing at all when it is already the one selected', async () => {
    await switchProfile('web')
    expect(ipc.profileSelect).not.toHaveBeenCalled()
    expect(useDialog.getState().pending).toBeNull()
  })

  it('records the choice without a question while nothing is running', async () => {
    vi.mocked(ipc.profileSelect).mockResolvedValueOnce(roster('lab', 'web', 'lab'))

    await switchProfile('lab')
    expect(ipc.profileSelect).toHaveBeenCalledWith('lab')
    expect(useDialog.getState().pending).toBeNull()
    expect(useHarness.getState().stop).not.toHaveBeenCalled()
  })

  it('offers the restart a running harness needs, and takes it', async () => {
    vi.mocked(ipc.profileSelect).mockResolvedValueOnce(roster('lab', 'web', 'lab'))
    serving()

    const switching = switchProfile('lab')
    await answer(true)
    await switching

    expect(useHarness.getState().stop).toHaveBeenCalledTimes(1)
    expect(useHarness.getState().start).toHaveBeenCalledTimes(1)
  })

  it('leaves live sessions alone when the restart is declined', async () => {
    vi.mocked(ipc.profileSelect).mockResolvedValueOnce(roster('lab', 'web', 'lab'))
    serving()

    const switching = switchProfile('lab')
    await answer(false)
    await switching

    // The choice is still recorded; it is the next start that acts on it.
    expect(ipc.profileSelect).toHaveBeenCalledWith('lab')
    expect(useHarness.getState().stop).not.toHaveBeenCalled()
  })

  it('never asks about a harness that failed to start', async () => {
    vi.mocked(ipc.profileSelect).mockResolvedValueOnce(roster('lab', 'web', 'lab'))
    useHarness.setState({ status: { phase: 'failed', reason: 'port refused' } })

    await switchProfile('lab')
    expect(useDialog.getState().pending).toBeNull()
  })
})

describe('the name a profile may be created under', () => {
  it('takes what the shell will make a package name out of', () => {
    for (const name of ['web', 'lab-2', 'lab_2', '2lab', 'a']) {
      expect(isNewProfileName(name), name).toBe(true)
    }
  })

  it('refuses what Rust would refuse a round trip later', () => {
    for (const name of [
      '',
      'Lab',
      'my lab',
      '-lab',
      '_lab',
      '.lab',
      'a/b',
      'a\\b',
      'node_modules',
      'x'.repeat(65),
    ]) {
      expect(isNewProfileName(name), name).toBe(false)
    }
  })
})

describe('profile import, export and shared reads', () => {
  it('duplicates and imports using the native roster rather than optimistic entries', async () => {
    vi.mocked(ipc.profileDuplicate).mockResolvedValueOnce(roster('web', 'web', 'copy'))
    await expect(useProfiles.getState().duplicate('web', 'copy')).resolves.toBe(true)
    expect(ipc.profileDuplicate).toHaveBeenCalledWith('web', 'copy')
    expect(useProfiles.getState().roster?.profiles.map((item) => item.name)).toEqual([
      'web',
      'copy',
    ])
    vi.mocked(ipc.profileImport).mockResolvedValueOnce(roster('web', 'web', 'copy', 'imported'))
    await expect(useProfiles.getState().load('D:/backup.json', 'imported')).resolves.toBe(true)
    expect(ipc.profileImport).toHaveBeenCalledWith('D:/backup.json', 'imported')
  })

  it('exports only to the requested path and settles the success note', async () => {
    await expect(useProfiles.getState().save('web', 'D:/backup.json')).resolves.toBe(true)
    expect(ipc.profileExport).toHaveBeenCalledWith('web', 'D:/backup.json')
    expect(useProfiles.getState().note).toContain('D:/backup.json')
    useProfiles.getState().settle()
    expect(useProfiles.getState()).toMatchObject({ note: null, error: null })
  })

  it('reports failed exports without claiming success', async () => {
    vi.mocked(ipc.profileExport).mockRejectedValueOnce(new Error('write refused'))
    await expect(useProfiles.getState().save('web', 'D:/backup.json')).resolves.toBe(false)
    expect(useProfiles.getState()).toMatchObject({ note: null, error: 'write refused' })
    expect(useDialog.getState().pending).toMatchObject({ kind: 'error', details: 'write refused' })
  })

  it('reads a verified declaration and rejects a damaged declaration', async () => {
    const declaration: ipc.Declaration = {
      kind: 'dsh-profile',
      version: 1,
      name: 'web',
      plugins: {},
      disabled: [],
      patch: '[]',
      verified: true,
    }
    vi.mocked(ipc.profileDeclaration).mockResolvedValueOnce(declaration)
    await expect(useProfiles.getState().read('D:/backup.json')).resolves.toEqual(declaration)
    vi.mocked(ipc.profileDeclaration).mockRejectedValueOnce(new Error('digest mismatch'))
    await expect(useProfiles.getState().read('D:/damaged.json')).resolves.toBeNull()
    expect(useProfiles.getState().error).toBe('digest mismatch')
  })

  it('keeps a current comparison, reports its failure and ignores stale failures', async () => {
    const comparison: Comparison = { left: 'web', right: 'lab', rows: [], differences: 0 }
    vi.mocked(ipc.profileCompare).mockResolvedValueOnce(comparison)
    await useProfiles.getState().compare('web', 'lab')
    expect(useProfiles.getState()).toMatchObject({ comparison, comparing: false })
    vi.mocked(ipc.profileCompare).mockRejectedValueOnce(new Error('comparison failed'))
    await useProfiles.getState().compare('web', 'missing')
    expect(useProfiles.getState()).toMatchObject({
      comparison: null,
      comparing: false,
      error: 'comparison failed',
    })
    let reject!: (cause: Error) => void
    vi.mocked(ipc.profileCompare).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail
      }),
    )
    const old = useProfiles.getState().compare('web', 'lab')
    vi.mocked(ipc.profileCompare).mockResolvedValueOnce(comparison)
    await useProfiles.getState().compare('web', 'lab')
    reject(new Error('old comparison failed'))
    await old
    expect(useProfiles.getState()).toMatchObject({ comparison, error: null })
  })

  it('refreshes both dependent stores only for a profiles announcement', async () => {
    let handler!: (subject: ipc.Shared) => void
    const stop = vi.fn()
    vi.mocked(ipc.onSharedChange).mockImplementationOnce(async (listen) => {
      handler = listen
      return stop
    })
    vi.mocked(ipc.profileRoster).mockResolvedValue(roster('web', 'web', 'lab'))
    const unsubscribe = await subscribeToProfiles()
    handler('theme')
    expect(ipc.profileRoster).not.toHaveBeenCalled()
    handler('profiles')
    await vi.waitFor(() => expect(ipc.profileRoster).toHaveBeenCalledOnce())
    expect(usePlugins.getState().refresh).toHaveBeenCalledOnce()
    unsubscribe()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('finds the hosted profile or returns null when no matching profile exists', () => {
    expect(hostedProfile(null)).toBeNull()
    expect(hostedProfile(roster('missing', 'web'))).toBeNull()
    expect(hostedProfile(roster('web', 'web'))?.name).toBe('web')
  })

  it('does not restart after a failed or already busy profile selection', async () => {
    useProfiles.setState({ working: 'busy' })
    await switchProfile('lab')
    expect(ipc.profileSelect).not.toHaveBeenCalled()
    useProfiles.setState({ working: null })
    vi.mocked(ipc.profileSelect).mockRejectedValueOnce(new Error('profile missing'))
    await switchProfile('lab')
    expect(useHarness.getState().stop).not.toHaveBeenCalled()
    expect(useHarness.getState().start).not.toHaveBeenCalled()
  })
})

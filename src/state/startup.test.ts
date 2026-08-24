import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { Startup } from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
import { useStartup } from '@/state/startup'

vi.mock('@/lib/ipc')

const state: Startup = {
  autostart: false,
  shortcut: null,
  held: false,
  suggested: 'CmdOrCtrl+Shift+KeyD',
  notifications: {
    turnCompleted: true,
    turnFailed: true,
    jobCompleted: true,
    jobFailed: true,
  },
  logLevel: 'info',
  harnessPort: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  useDialog.setState({ pending: null })
  useStartup.setState({ state: null, busy: false, error: null })
  vi.mocked(ipc.startupState).mockResolvedValue(state)
})

describe('desktop startup settings', () => {
  it('reads the operating-system and persisted state together', async () => {
    await useStartup.getState().refresh()
    expect(useStartup.getState().state).toEqual(state)
  })

  it('changes one notification preference and keeps the backend answer', async () => {
    const changed = {
      ...state,
      notifications: { ...state.notifications, jobFailed: false },
    }
    vi.mocked(ipc.startupNotification).mockResolvedValue(changed)

    await useStartup.getState().setNotification('job-failed', false)

    expect(ipc.startupNotification).toHaveBeenCalledWith('job-failed', false)
    expect(useStartup.getState().state).toEqual(changed)
    expect(useStartup.getState().busy).toBe(false)
  })

  it('keeps the current state and exposes a failed write', async () => {
    useStartup.setState({ state })
    vi.mocked(ipc.startupNotification).mockRejectedValue('settings file is read-only')

    await useStartup.getState().setNotification('turn-completed', false)

    expect(useStartup.getState().state).toEqual(state)
    expect(useStartup.getState().error).toBe('settings file is read-only')
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'settings file is read-only',
    })
  })

  it('changes the persistent log level using the backend answer', async () => {
    const changed = { ...state, logLevel: 'error' as const }
    vi.mocked(ipc.startupLogLevel).mockResolvedValue(changed)

    await useStartup.getState().setLogLevel('error')

    expect(ipc.startupLogLevel).toHaveBeenCalledWith('error')
    expect(useStartup.getState().state).toEqual(changed)
  })

  it('persists a stable Harness port and can return to automatic allocation', async () => {
    vi.mocked(ipc.startupHarnessPort)
      .mockResolvedValueOnce({ ...state, harnessPort: 3080 })
      .mockResolvedValueOnce(state)

    await useStartup.getState().setHarnessPort(3080)
    expect(ipc.startupHarnessPort).toHaveBeenLastCalledWith(3080)
    expect(useStartup.getState().state?.harnessPort).toBe(3080)

    await useStartup.getState().setHarnessPort(null)
    expect(ipc.startupHarnessPort).toHaveBeenLastCalledWith(null)
    expect(useStartup.getState().state?.harnessPort).toBeNull()
  })

  it('does not let an older settings read undo a completed change', async () => {
    let finishRefresh!: (answer: Startup) => void
    vi.mocked(ipc.startupState).mockReturnValue(
      new Promise<Startup>((resolve) => {
        finishRefresh = resolve
      }),
    )
    const changed = { ...state, autostart: true }
    vi.mocked(ipc.startupAutostart).mockResolvedValue(changed)

    const refresh = useStartup.getState().refresh()
    await useStartup.getState().setAutostart(true)
    finishRefresh(state)
    await refresh

    expect(useStartup.getState().state).toEqual(changed)
  })

  it('ignores a refresh requested while a settings write is active', async () => {
    let finish!: (answer: Startup) => void
    vi.mocked(ipc.startupAutostart).mockReturnValue(
      new Promise<Startup>((resolve) => {
        finish = resolve
      }),
    )

    const changing = useStartup.getState().setAutostart(true)
    await useStartup.getState().refresh()

    expect(ipc.startupState).not.toHaveBeenCalled()
    finish({ ...state, autostart: true })
    await changing
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { Startup } from '@/lib/ipc'
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
}

beforeEach(() => {
  vi.clearAllMocks()
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
  })
})

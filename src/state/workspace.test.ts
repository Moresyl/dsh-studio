import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
import { useHarness } from '@/state/harness'
import { switchWorkspace } from '@/state/workspace'

vi.mock('@/lib/ipc')

const answer = async (taken: boolean): Promise<void> => {
  await vi.waitFor(() => expect(useDialog.getState().pending).not.toBeNull())
  useDialog.getState().settle(taken)
}

beforeEach(() => {
  vi.clearAllMocks()
  useDialog.setState({ pending: null })
  useHarness.setState({
    status: { phase: 'stopped' },
    error: null,
    inspect: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
  })
  vi.mocked(ipc.workspaceSelect).mockResolvedValue({
    state: 'safe',
    filesystem: 'NTFS',
    reason: null,
  })
})

describe('selecting a native workspace', () => {
  it('persists and refreshes it without restarting a stopped Harness', async () => {
    expect(await switchWorkspace('D:\\work')).toBe(true)
    expect(ipc.workspaceSelect).toHaveBeenCalledWith('D:\\work')
    expect(useHarness.getState().inspect).toHaveBeenCalledTimes(1)
    expect(useHarness.getState().stop).not.toHaveBeenCalled()
  })

  it('offers and performs the restart needed by a running Harness', async () => {
    useHarness.setState({
      status: { phase: 'ready', origin: 'http://127.0.0.1:8100', pid: 42 },
    })

    const changing = switchWorkspace('D:\\next')
    await answer(true)
    expect(await changing).toBe(true)
    expect(useHarness.getState().stop).toHaveBeenCalledTimes(1)
    expect(useHarness.getState().start).toHaveBeenCalledTimes(1)
  })

  it('shows the backend refusal and leaves the current Harness alone', async () => {
    vi.mocked(ipc.workspaceSelect).mockRejectedValueOnce('removable workspaces are blocked')

    expect(await switchWorkspace('E:\\unsafe')).toBe(false)
    expect(useHarness.getState().error).toBe('removable workspaces are blocked')
    expect(useHarness.getState().inspect).not.toHaveBeenCalled()
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'removable workspaces are blocked',
    })
  })
})

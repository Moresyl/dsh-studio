import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { RemoteStatus } from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
import { useRemote } from '@/state/remote'

vi.mock('@/lib/ipc')

const status = (open: boolean): RemoteStatus => ({
  open,
  addresses: [],
  url: open ? 'http://192.0.2.1:57652' : null,
  pairingUrl: null,
  qr: null,
  codeSecondsLeft: null,
  codeLifetimeSeconds: 120,
  devices: [],
  active: 0,
  served: 0,
  refused: 0,
})

beforeEach(() => {
  vi.clearAllMocks()
  useDialog.setState({ pending: null })
  useRemote.setState({ status: status(false), busy: false, error: null })
})

describe('remote access state', () => {
  it('sends only one close while the first request is still in flight', async () => {
    let finish!: (answer: RemoteStatus) => void
    vi.mocked(ipc.remoteClose).mockReturnValue(
      new Promise<RemoteStatus>((resolve) => {
        finish = resolve
      }),
    )

    const first = useRemote.getState().close()
    await useRemote.getState().close()

    expect(ipc.remoteClose).toHaveBeenCalledOnce()
    finish(status(false))
    await first
  })

  it('does not let an older refresh overwrite a newer open result', async () => {
    let finishRefresh!: (answer: RemoteStatus) => void
    vi.mocked(ipc.remoteStatus).mockReturnValue(
      new Promise<RemoteStatus>((resolve) => {
        finishRefresh = resolve
      }),
    )
    vi.mocked(ipc.remoteOpen).mockResolvedValue(status(true))

    const refresh = useRemote.getState().refresh()
    await useRemote.getState().open()
    finishRefresh(status(false))
    await refresh

    expect(useRemote.getState().status?.open).toBe(true)
  })

  it('keeps a successful open authoritative over its event refresh failure', async () => {
    let finishOpen!: (answer: RemoteStatus) => void
    vi.mocked(ipc.remoteOpen).mockReturnValue(
      new Promise<RemoteStatus>((resolve) => {
        finishOpen = resolve
      }),
    )
    vi.mocked(ipc.remoteStatus).mockRejectedValue('status event was lost')

    const opening = useRemote.getState().open()
    await useRemote.getState().refresh()
    finishOpen(status(true))
    await opening

    expect(useRemote.getState().status?.open).toBe(true)
    expect(useRemote.getState().error).toBeNull()
  })

  it('keeps the newest renewed pairing status', async () => {
    let finishFirst!: (answer: RemoteStatus) => void
    const first = { ...status(true), codeSecondsLeft: 30 }
    const second = { ...status(true), codeSecondsLeft: 120 }
    vi.mocked(ipc.remoteRenew)
      .mockReturnValueOnce(
        new Promise<RemoteStatus>((resolve) => {
          finishFirst = resolve
        }),
      )
      .mockResolvedValueOnce(second)

    const older = useRemote.getState().renew()
    await useRemote.getState().renew()
    finishFirst(first)
    await older

    expect(useRemote.getState().status?.codeSecondsLeft).toBe(120)
  })

  it('opens a copyable failure dialog for a refused user mutation', async () => {
    vi.mocked(ipc.remoteOpen).mockRejectedValueOnce('the selected port is already in use')

    await useRemote.getState().open()

    expect(useRemote.getState().busy).toBe(false)
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'the selected port is already in use',
    })
  })

  it('does not interrupt the user when a background status refresh fails', async () => {
    vi.mocked(ipc.remoteStatus).mockRejectedValueOnce('network interface unavailable')

    await useRemote.getState().refresh()

    expect(useRemote.getState().error).toBe('network interface unavailable')
    expect(useDialog.getState().pending).toBeNull()
  })
})

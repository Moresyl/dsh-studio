import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { RemoteStatus } from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
import { subscribeToRemote, useRemote } from '@/state/remote'

vi.mock('@/lib/ipc')

const status = (open: boolean): RemoteStatus => ({
  open,
  suspended: false,
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
  vi.resetAllMocks()
  useDialog.setState({ pending: null })
  useRemote.setState({ status: status(false), busy: false, error: null })
})

describe('remote access state', () => {
  it('deduplicates open while a native request is pending', async () => {
    let finish!: (answer: RemoteStatus) => void
    vi.mocked(ipc.remoteOpen).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const first = useRemote.getState().open()
    await useRemote.getState().open()
    expect(ipc.remoteOpen).toHaveBeenCalledOnce()
    finish(status(true))
    await first
    expect(useRemote.getState()).toMatchObject({ busy: false, error: null })
  })

  it('keeps the newest overlapping background read', async () => {
    let finish!: (answer: RemoteStatus) => void
    vi.mocked(ipc.remoteStatus)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        }),
      )
      .mockResolvedValueOnce(status(true))
    const older = useRemote.getState().refresh()
    await useRemote.getState().refresh()
    finish(status(false))
    await older
    expect(useRemote.getState().status?.open).toBe(true)
  })

  it('ignores a stale background error after a successful close', async () => {
    let fail!: (cause: Error) => void
    vi.mocked(ipc.remoteStatus).mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject
      }),
    )
    vi.mocked(ipc.remoteClose).mockResolvedValueOnce(status(false))
    const older = useRemote.getState().refresh()
    await useRemote.getState().close()
    fail(new Error('old interface failure'))
    await older
    expect(useRemote.getState()).toMatchObject({ status: { open: false }, error: null })
    expect(useDialog.getState().pending).toBeNull()
  })

  it('keeps the open state visible when native close refuses', async () => {
    useRemote.setState({ status: status(true) })
    vi.mocked(ipc.remoteClose).mockRejectedValueOnce(new Error('close refused'))
    await useRemote.getState().close()
    expect(useRemote.getState()).toMatchObject({
      status: { open: true },
      busy: false,
      error: 'close refused',
    })
    expect(useDialog.getState().pending).toMatchObject({ kind: 'error', details: 'close refused' })
  })

  it.each(['renew', 'forget'] as const)(
    'reports a current %s failure without claiming success',
    async (action) => {
      useRemote.setState({ status: status(true) })
      const command = action === 'renew' ? ipc.remoteRenew : ipc.remoteForget
      vi.mocked(command).mockRejectedValueOnce(new Error('native refusal'))
      if (action === 'renew') await useRemote.getState().renew()
      else await useRemote.getState().forget('device-1')
      expect(useRemote.getState()).toMatchObject({
        status: { open: true },
        error: 'native refusal',
      })
      expect(useDialog.getState().pending).toMatchObject({
        kind: 'error',
        details: 'native refusal',
      })
    },
  )

  it.each(['renew', 'forget'] as const)(
    'ignores a late %s failure after closing',
    async (action) => {
      let fail!: (cause: Error) => void
      const command = action === 'renew' ? ipc.remoteRenew : ipc.remoteForget
      vi.mocked(command).mockReturnValueOnce(
        new Promise((_, reject) => {
          fail = reject
        }),
      )
      vi.mocked(ipc.remoteClose).mockResolvedValueOnce(status(false))
      const older =
        action === 'renew' ? useRemote.getState().renew() : useRemote.getState().forget('device-1')
      await useRemote.getState().close()
      fail(new Error('obsolete refusal'))
      await older
      expect(useRemote.getState()).toMatchObject({ status: { open: false }, error: null })
      expect(useDialog.getState().pending).toBeNull()
    },
  )

  it('forgets only the selected device and accepts the native answer', async () => {
    const next = { ...status(true), served: 12 }
    vi.mocked(ipc.remoteForget).mockResolvedValueOnce(next)
    await useRemote.getState().forget('device-1')
    expect(ipc.remoteForget).toHaveBeenCalledWith('device-1')
    expect(useRemote.getState().status).toEqual(next)
  })

  it('does not let a late forget answer reopen a closed gateway', async () => {
    let finish!: (answer: RemoteStatus) => void
    vi.mocked(ipc.remoteForget).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    vi.mocked(ipc.remoteClose).mockResolvedValueOnce(status(false))
    const older = useRemote.getState().forget('device-1')
    await useRemote.getState().close()
    finish(status(true))
    await older
    expect(useRemote.getState().status?.open).toBe(false)
  })

  it('follows native events and returns their cleanup function', async () => {
    let change!: () => void
    const cleanup = vi.fn()
    vi.mocked(ipc.onRemoteChange).mockImplementationOnce(async (handler) => {
      change = handler
      return cleanup
    })
    vi.mocked(ipc.remoteStatus).mockResolvedValueOnce(status(false))
    const stop = await subscribeToRemote()
    change()
    await vi.waitFor(() => expect(ipc.remoteStatus).toHaveBeenCalledOnce())
    stop()
    expect(cleanup).toHaveBeenCalledOnce()
  })

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

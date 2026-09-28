import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  applicationUpdateReview: vi.fn(),
  applicationUpdateInstall: vi.fn(),
  applicationUpdateDiscard: vi.fn(),
  applicationUpdateCancel: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ipc)

import {
  cancelUpdate,
  checkForUpdate,
  discardReview,
  installUpdate,
  notesForDisplay,
  reviewVersion,
  UpdateCancelled,
  type Release,
} from '@/lib/updater'

const release = (): Release => ({
  version: '0.9.19',
  currentVersion: '0.9.18',
  reviewId: 'a'.repeat(32),
  fingerprint: 'b'.repeat(64),
  url: 'https://github.com/Moresyl/dsh-studio/releases/tag/v0.9.19',
  notes: 'Fixed a bug',
  published: '2026-09-29T00:00:00Z',
  artifact: 'Studio.exe',
  bytes: 100,
  direction: 'newer',
  canInstall: true,
  installBlock: null,
})

beforeEach(() => {
  vi.resetAllMocks()
  ipc.applicationUpdateDiscard.mockResolvedValue(undefined)
  ipc.applicationUpdateInstall.mockResolvedValue(undefined)
})

describe('reviewed application updates', () => {
  it('represents an up-to-date result without a fake release', async () => {
    ipc.applicationUpdateReview.mockResolvedValue(null)
    await expect(checkForUpdate()).resolves.toBeNull()
    expect(ipc.applicationUpdateReview).toHaveBeenCalledWith(null)
  })

  it('preserves native identity and direction', async () => {
    const review = release()
    ipc.applicationUpdateReview.mockResolvedValue(review)
    await expect(checkForUpdate()).resolves.toEqual(review)
  })

  it('retries one transient check failure', async () => {
    ipc.applicationUpdateReview
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(null)
    await expect(checkForUpdate()).resolves.toBeNull()
    expect(ipc.applicationUpdateReview).toHaveBeenCalledTimes(2)
  })

  it.each([
    '',
    '../0.9.19',
    '0.9',
    'v0.9.19',
    '00.9.19',
    '0.9.19-rc.1',
    '0.9.19+build',
    '0.9.19/installer',
  ])('rejects unsafe selected version %s before IPC', async (version) => {
    await expect(reviewVersion(version)).rejects.toThrow(/invalid version/)
    expect(ipc.applicationUpdateReview).not.toHaveBeenCalled()
  })

  it('rejects malformed native identities and discards their receipts', async () => {
    ipc.applicationUpdateReview.mockResolvedValue({ ...release(), fingerprint: 'invalid' })
    await expect(checkForUpdate()).rejects.toThrow(/review is invalid/)
    expect(ipc.applicationUpdateDiscard).toHaveBeenCalledTimes(2)
  })

  it('retains actionable bilingual network guidance', async () => {
    ipc.applicationUpdateReview.mockRejectedValue(new Error('rate limited'))
    await expect(checkForUpdate()).rejects.toThrow(/HTTPS_PROXY.*无法连接[^]*rate limited/)
  })

  it('provides guidance for an empty failure', async () => {
    ipc.applicationUpdateReview.mockRejectedValue('')
    await expect(checkForUpdate()).rejects.toThrow(/verified update feed/)
  })

  it('requires the explicit historical version, including missing releases', async () => {
    ipc.applicationUpdateReview.mockResolvedValue(release())
    await expect(reviewVersion('0.9.18')).rejects.toThrow(/changed/)
    expect(ipc.applicationUpdateDiscard).toHaveBeenCalledOnce()
    ipc.applicationUpdateReview.mockResolvedValue(null)
    await expect(reviewVersion('0.9.18')).rejects.toThrow(/changed/)
  })

  it('returns a matching historical review', async () => {
    const review = release()
    ipc.applicationUpdateReview.mockResolvedValue(review)
    await expect(reviewVersion('0.9.19')).resolves.toEqual(review)
  })
})

describe('installing exactly what was reviewed', () => {
  it('renews the receipt, forwards progress and releases metadata', async () => {
    const expected = release()
    const current = { ...expected, reviewId: 'c'.repeat(32) }
    ipc.applicationUpdateReview.mockResolvedValue(current)
    ipc.applicationUpdateInstall.mockImplementation(async (_id, report) => {
      report({ phase: 'downloading', downloaded: 40, total: 100 })
      report({ phase: 'installing', downloaded: 100, total: 100 })
    })
    const progress = vi.fn()
    const reviewed = vi.fn()
    await expect(installUpdate(expected, progress, 'latest', reviewed)).resolves.toBe(true)
    expect(reviewed).toHaveBeenCalledWith(current)
    expect(ipc.applicationUpdateInstall).toHaveBeenCalledWith(
      current.reviewId,
      expect.any(Function),
    )
    expect(progress).toHaveBeenLastCalledWith({ phase: 'installing', downloaded: 100, total: 100 })
    expect(ipc.applicationUpdateDiscard).toHaveBeenCalledWith(current.reviewId)
  })

  it('pins historical checks while normal updates still recheck latest', async () => {
    ipc.applicationUpdateReview.mockResolvedValue(release())
    await installUpdate(release(), vi.fn(), 'selected')
    expect(ipc.applicationUpdateReview).toHaveBeenCalledWith('0.9.19')
  })

  it.each(['version', 'fingerprint'] as const)(
    'rejects changed %s before installation',
    async (field) => {
      const changed = { ...release(), [field]: field === 'version' ? '0.9.20' : 'c'.repeat(64) }
      if (field === 'version')
        changed.url = 'https://github.com/Moresyl/dsh-studio/releases/tag/v0.9.20'
      ipc.applicationUpdateReview.mockResolvedValue(changed)
      await expect(installUpdate(release(), vi.fn())).rejects.toThrow(/changed/)
      expect(ipc.applicationUpdateInstall).not.toHaveBeenCalled()
      expect(ipc.applicationUpdateDiscard).toHaveBeenCalled()
    },
  )

  it('does not install when the release disappeared', async () => {
    ipc.applicationUpdateReview.mockResolvedValue(null)
    await expect(installUpdate(release(), vi.fn())).resolves.toBe(false)
    expect(ipc.applicationUpdateInstall).not.toHaveBeenCalled()
  })

  it('never installs a development build', async () => {
    await expect(installUpdate({ ...release(), canInstall: false }, vi.fn())).rejects.toThrow(
      /development builds/,
    )
    expect(ipc.applicationUpdateReview).not.toHaveBeenCalled()
  })

  it('explains unsupported RPM downgrades before starting any request', async () => {
    await expect(
      installUpdate({ ...release(), canInstall: false, installBlock: 'rpmDowngrade' }, vi.fn()),
    ).rejects.toThrow(/system package manager/)
    expect(ipc.applicationUpdateReview).not.toHaveBeenCalled()
    expect(ipc.applicationUpdateInstall).not.toHaveBeenCalled()
  })

  it('preserves the original signature failure if receipt cleanup fails', async () => {
    ipc.applicationUpdateReview.mockResolvedValue(release())
    ipc.applicationUpdateInstall.mockRejectedValue(new Error('signature rejected'))
    ipc.applicationUpdateDiscard.mockRejectedValue(new Error('window closed'))
    await expect(installUpdate(release(), vi.fn())).rejects.toThrow('signature rejected')
  })

  it('recognizes native and pre-download cancellation', async () => {
    ipc.applicationUpdateReview.mockResolvedValue(release())
    ipc.applicationUpdateInstall.mockRejectedValue('application update cancelled')
    await expect(installUpdate(release(), vi.fn())).rejects.toBeInstanceOf(UpdateCancelled)
    ipc.applicationUpdateInstall.mockClear()
    await expect(
      installUpdate(release(), vi.fn(), 'latest', () => {
        throw new UpdateCancelled()
      }),
    ).rejects.toBeInstanceOf(UpdateCancelled)
    expect(ipc.applicationUpdateInstall).not.toHaveBeenCalled()
  })

  it('bounds malformed progress without displaying negative or infinite amounts', async () => {
    ipc.applicationUpdateReview.mockResolvedValue(release())
    ipc.applicationUpdateInstall.mockImplementation(async (_id, report) => {
      report({ phase: 'downloading', downloaded: 120, total: 100 })
      report({ phase: 'downloading', downloaded: Number.NaN, total: 0 })
    })
    const progress = vi.fn()
    await installUpdate(release(), progress)
    expect(progress).toHaveBeenNthCalledWith(1, {
      phase: 'downloading',
      downloaded: 100,
      total: 100,
    })
    expect(progress).toHaveBeenLastCalledWith({ phase: 'downloading', downloaded: 0, total: null })
  })

  it('cancels only the active reviewed identity and safely discards an absent review', async () => {
    ipc.applicationUpdateCancel.mockResolvedValue(true)
    await expect(cancelUpdate(release())).resolves.toBe(true)
    expect(ipc.applicationUpdateCancel).toHaveBeenCalledWith(release().reviewId)
    await discardReview(null)
    expect(ipc.applicationUpdateDiscard).not.toHaveBeenCalled()
  })
})

describe('notesForDisplay', () => {
  const notes = `<!-- dsh-notes:zh -->
### 修复
- **修好了**路径问题
<!-- dsh-notes:en -->
### Fixed
- **Fixed** the path issue
<!-- dsh-notes:end -->`
  it('selects and cleans Chinese notes for a Chinese locale', () => {
    expect(notesForDisplay(notes, 'zh-CN')).toBe('修复\n- 修好了路径问题')
  })
  it('selects English for other locales', () => {
    expect(notesForDisplay(notes, 'en-US')).toBe('Fixed\n- Fixed the path issue')
  })
  it('keeps ordinary release bodies that predate localized markers', () => {
    expect(notesForDisplay('### Fixed\n- [Issue](https://example.com)', 'zh-CN')).toBe(
      'Fixed\n- Issue',
    )
  })
  it('reads a final locale block without a closing marker', () => {
    expect(notesForDisplay('<!-- dsh-notes:en -->\n## Finished', 'en')).toBe('Finished')
  })
})

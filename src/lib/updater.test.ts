import { beforeEach, describe, expect, it, vi } from 'vitest'

const close = vi.fn()
const downloadAndInstall = vi.fn()
const check = vi.fn()
const relaunch = vi.fn()

vi.mock('@tauri-apps/plugin-updater', () => ({ check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }))

import { checkForUpdate, installUpdate, notesForDisplay } from '@/lib/updater'

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  relaunch.mockResolvedValue(undefined)
})

describe('checkForUpdate', () => {
  it('returns null when the signed manifest has no newer version', async () => {
    check.mockResolvedValue(null)

    await expect(checkForUpdate()).resolves.toBeNull()
  })

  it('normalizes updater metadata and releases the native resource', async () => {
    check.mockResolvedValue({
      version: 'v0.4.0',
      body: '  fixed it  ',
      date: '2026-08-18T00:00:00Z',
      close,
    })

    await expect(checkForUpdate()).resolves.toEqual({
      version: '0.4.0',
      url: 'https://github.com/Moresyl/dsh-studio/releases/tag/v0.4.0',
      notes: 'fixed it',
      published: '2026-08-18T00:00:00Z',
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the updater resource even when metadata handling throws', async () => {
    check.mockResolvedValue({ version: null, close })

    await expect(checkForUpdate()).rejects.toThrow()
    expect(close).toHaveBeenCalledOnce()
  })

  it('turns a feed outage into an actionable bilingual error', async () => {
    check.mockRejectedValue(new Error('error sending request for url'))

    await expect(checkForUpdate()).rejects.toThrow(/HTTPS_PROXY.*无法连接/s)
  })
})

describe('installUpdate', () => {
  it('reports cumulative progress, installs, then relaunches', async () => {
    downloadAndInstall.mockImplementation(async (report) => {
      report({ event: 'Started', data: { contentLength: 10 } })
      report({ event: 'Progress', data: { chunkLength: 4 } })
      report({ event: 'Progress', data: { chunkLength: 6 } })
      report({ event: 'Finished' })
    })
    check.mockResolvedValue({ downloadAndInstall, close })
    const progress = vi.fn()

    await expect(installUpdate(progress)).resolves.toBe(true)

    expect(progress).toHaveBeenLastCalledWith({ downloaded: 10, total: 10 })
    expect(relaunch).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not relaunch when the update disappeared before installation', async () => {
    check.mockResolvedValue(null)

    await expect(installUpdate(vi.fn())).resolves.toBe(false)
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('closes the native resource and leaves relaunch alone after a download failure', async () => {
    downloadAndInstall.mockRejectedValue(new Error('network lost'))
    check.mockResolvedValue({ downloadAndInstall, close })

    await expect(installUpdate(vi.fn())).rejects.toThrow(/Full \/ Offline.*network lost/s)
    expect(relaunch).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
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
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const close = vi.fn()
const downloadAndInstall = vi.fn()
const check = vi.fn()
const relaunch = vi.fn()

vi.mock('@tauri-apps/plugin-updater', () => ({ check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }))

import { checkForUpdate, installUpdate, notesForDisplay } from '@/lib/updater'

beforeEach(() => {
  vi.resetAllMocks()
  close.mockResolvedValue(undefined)
  relaunch.mockResolvedValue(undefined)
})

describe('checkForUpdate', () => {
  it('returns null when the signed manifest has no newer version', async () => {
    check.mockResolvedValue(null)

    await expect(checkForUpdate()).resolves.toBeNull()
    expect(check).toHaveBeenCalledOnce()
  })

  it('recovers from a first feed failure without retrying a successful check', async () => {
    check.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce(null)

    await expect(checkForUpdate()).resolves.toBeNull()
    expect(check).toHaveBeenCalledTimes(2)
    expect(check).toHaveBeenNthCalledWith(1, { timeout: 15_000 })
    expect(check).toHaveBeenNthCalledWith(2, { timeout: 15_000 })
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

  it.each(['', '../0.4.0', '0.4', '0.4.0<script>', '0.4.0/installer'])(
    'rejects unsafe release identity %s before building a link',
    async (version) => {
      check.mockResolvedValue({ version, close })
      await expect(checkForUpdate()).rejects.toThrow(/invalid version/)
      expect(close).toHaveBeenCalledOnce()
    },
  )

  it('accepts prerelease/build identifiers and missing optional metadata', async () => {
    check.mockResolvedValue({ version: '  v1.2.3-rc.10+build.2  ', close })
    await expect(checkForUpdate()).resolves.toMatchObject({
      version: '1.2.3-rc.10+build.2',
      notes: '',
      published: '',
    })
  })

  it('reports resource cleanup errors even after a successful feed response', async () => {
    check.mockResolvedValue({ version: '1.2.3', close })
    close.mockRejectedValue(new Error('resource unavailable'))
    await expect(checkForUpdate()).rejects.toThrow(/cleanup/)
  })

  it('keeps the fallback guidance when a failure has no detail', async () => {
    check.mockRejectedValue('')
    await expect(checkForUpdate()).rejects.toThrow(/signed update feed/)
  })

  it('turns a feed outage into an actionable bilingual error', async () => {
    check.mockRejectedValue(new Error('error sending request for url'))

    await expect(checkForUpdate()).rejects.toThrow(/HTTPS_PROXY.*无法连接/s)
    expect(check).toHaveBeenCalledTimes(2)
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
    check.mockResolvedValue({ version: '0.4.0', downloadAndInstall, close })
    const progress = vi.fn()

    await expect(installUpdate('0.4.0', progress)).resolves.toBe(true)

    expect(progress).toHaveBeenLastCalledWith({ downloaded: 10, total: 10 })
    expect(relaunch).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not relaunch when the update disappeared before installation', async () => {
    check.mockResolvedValue(null)

    await expect(installUpdate('0.4.0', vi.fn())).resolves.toBe(false)
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('closes the native resource and leaves relaunch alone after a download failure', async () => {
    downloadAndInstall.mockRejectedValue(new Error('network lost'))
    close.mockRejectedValueOnce(new Error('cleanup lost'))
    check.mockResolvedValue({ version: '0.4.0', downloadAndInstall, close })

    await expect(installUpdate('0.4.0', vi.fn())).rejects.toThrow(/Full \/ Offline.*network lost/s)
    expect(relaunch).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('reports cleanup failure after a successful update', async () => {
    check.mockResolvedValue({ version: '0.4.0', downloadAndInstall, close })
    close.mockRejectedValueOnce(new Error('cleanup lost'))
    await expect(installUpdate('0.4.0', vi.fn())).rejects.toThrow(/更新器未能完成清理/)
  })

  it('requires a fresh review when latest changed after confirmation', async () => {
    check.mockResolvedValue({ version: '0.5.0', downloadAndInstall, close })

    await expect(installUpdate('0.4.0', vi.fn())).rejects.toThrow(/changed.*review/s)
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the native resource when install metadata has an invalid version', async () => {
    check.mockResolvedValue({ version: null, downloadAndInstall, close })

    await expect(installUpdate('0.4.0', vi.fn())).rejects.toThrow(/valid version/)
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('never reports more than the signed artifact content length', async () => {
    downloadAndInstall.mockImplementation(async (report) => {
      report({ event: 'Started', data: { contentLength: 10 } })
      report({ event: 'Progress', data: { chunkLength: 12 } })
    })
    check.mockResolvedValue({ version: '0.4.0', downloadAndInstall, close })
    const progress = vi.fn()

    await installUpdate('0.4.0', progress)

    expect(progress).toHaveBeenLastCalledWith({ downloaded: 10, total: 10 })
  })

  it('explains that a manual restart is required if relaunch fails after installation', async () => {
    downloadAndInstall.mockResolvedValue(undefined)
    relaunch.mockRejectedValue(new Error('process plugin unavailable'))
    check.mockResolvedValue({ version: '0.4.0', downloadAndInstall, close })

    await expect(installUpdate('0.4.0', vi.fn())).rejects.toThrow(/installed.*start.*again/s)
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps download progress useful without a Content-Length', async () => {
    downloadAndInstall.mockImplementation(async (report) => {
      report({ event: 'Started', data: {} })
      report({ event: 'Progress', data: { chunkLength: 8 } })
      report({ event: 'Finished' })
    })
    check.mockResolvedValue({ version: '0.4.0', downloadAndInstall, close })
    const progress = vi.fn()
    await installUpdate('0.4.0', progress)
    expect(progress).toHaveBeenLastCalledWith({ downloaded: 8, total: null })
  })

  it('retains manual-restart guidance for an empty relaunch failure', async () => {
    relaunch.mockRejectedValue('')
    check.mockResolvedValue({ version: '0.4.0', downloadAndInstall, close })
    await expect(installUpdate('0.4.0', vi.fn())).rejects.toThrow(/手动|重新启动/)
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

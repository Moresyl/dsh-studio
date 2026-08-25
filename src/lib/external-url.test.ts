import { beforeEach, describe, expect, it, vi } from 'vitest'

import { normalizeExternalUrl, openExternalUrl } from '@/lib/external-url'
import { openUrl } from '@tauri-apps/plugin-opener'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('normalizeExternalUrl', () => {
  it('normalizes npm-style Git repository links', () => {
    expect(normalizeExternalUrl('git+https://github.com/Moresyl/dsh-studio.git')).toBe(
      'https://github.com/Moresyl/dsh-studio',
    )
  })

  it('keeps loopback HTTP links used by the local Harness', () => {
    expect(normalizeExternalUrl('http://127.0.0.1:31415/session?id=1')).toBe(
      'http://127.0.0.1:31415/session?id=1',
    )
  })

  it.each([
    'file:///C:/Users/person/.ssh/config',
    'javascript:alert(1)',
    'mailto:person@example.com',
    'dsh://profile/import',
    '../relative/path',
    'https://user:secret@example.com/',
    'https://example.com/\nfile:///tmp/secret',
  ])('rejects a non-web or deceptive target: %s', (target) => {
    expect(() => normalizeExternalUrl(target)).toThrow()
  })
})

describe('openExternalUrl', () => {
  it('hands only the normalized URL to the native opener', async () => {
    vi.mocked(openUrl).mockResolvedValue(undefined)

    await openExternalUrl(' https://example.com/docs ')

    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('does not call the native opener for a rejected scheme', async () => {
    await expect(openExternalUrl('file:///tmp/private')).rejects.toThrow()
    expect(openUrl).not.toHaveBeenCalled()
  })
})

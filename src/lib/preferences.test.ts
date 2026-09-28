import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { preferenceSave } from '@/lib/ipc'
import { reportFailure } from '@/state/failure'
import { flushPreferences, readPreference, savePreference } from './preferences'

vi.mock('@/lib/ipc', () => ({ preferenceSave: vi.fn() }))
vi.mock('@/state/failure', () => ({ reportFailure: vi.fn() }))

const values = new Map<string, string>()
const storage = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    values.set(key, value)
  }),
}

beforeEach(() => {
  vi.clearAllMocks()
  values.clear()
  vi.mocked(preferenceSave).mockResolvedValue(undefined)
  vi.stubGlobal('window', { localStorage: storage, __DSH_SAVED_PREFERENCES__: {} })
})

afterEach(async () => {
  await flushPreferences().catch(() => {})
  vi.unstubAllGlobals()
})

describe('origin-independent preferences', () => {
  it('reads current shared storage before the startup snapshot', () => {
    window.__DSH_SAVED_PREFERENCES__!['dsh-studio.theme'] = 'dark'
    expect(readPreference('dsh-studio.theme')).toBe('dark')
    values.set('dsh-studio.theme', 'light')
    expect(readPreference('dsh-studio.theme')).toBe('light')
    expect(readPreference('missing')).toBeNull()
  })

  it('uses the native snapshot if Web storage is disabled', async () => {
    storage.getItem.mockImplementationOnce(() => {
      throw new Error('disabled')
    })
    window.__DSH_SAVED_PREFERENCES__!['dsh-studio.theme'] = 'dark'
    expect(readPreference('dsh-studio.theme')).toBe('dark')
    storage.setItem.mockImplementationOnce(() => {
      throw new Error('disabled')
    })
    savePreference('dsh-studio.theme', 'light')
    await flushPreferences()
    expect(preferenceSave).toHaveBeenCalledExactlyOnceWith('dsh-studio.theme', 'light')
    expect(readPreference('dsh-studio.theme')).toBe('light')
  })

  it('preserves rapid save order and does not let failure block later writes', async () => {
    vi.mocked(preferenceSave).mockRejectedValueOnce('disk unavailable')
    savePreference('dsh-studio.theme', 'dark')
    savePreference('dsh-studio.theme', 'light')
    await flushPreferences()
    expect(preferenceSave).toHaveBeenNthCalledWith(1, 'dsh-studio.theme', 'dark')
    expect(preferenceSave).toHaveBeenNthCalledWith(2, 'dsh-studio.theme', 'light')
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith('disk unavailable')
  })

  it('keeps browser previews local and tolerates an absent window during tests', async () => {
    vi.stubGlobal('window', { localStorage: storage })
    savePreference('dsh-studio.theme', 'dark')
    await flushPreferences()
    expect(preferenceSave).not.toHaveBeenCalled()
    expect(readPreference('dsh-studio.theme')).toBe('dark')
    vi.stubGlobal('window', undefined)
    expect(readPreference('dsh-studio.theme')).toBeNull()
  })
})

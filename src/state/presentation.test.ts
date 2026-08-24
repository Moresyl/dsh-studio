import { beforeEach, describe, expect, it, vi } from 'vitest'

const shared = vi.hoisted(() => ({
  announce: vi.fn(),
  onSharedChange: vi.fn().mockResolvedValue(() => {}),
}))

vi.mock('@/lib/ipc', () => shared)

const stored = new Map<string, string>()
const localStorage = {
  getItem: vi.fn((key: string) => stored.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
}

beforeEach(() => {
  vi.clearAllMocks()
  stored.clear()
  vi.stubGlobal('window', { localStorage })
})

describe('presentation preference', () => {
  it('defaults to compatibility and persists advanced mode', async () => {
    vi.resetModules()
    const { usePresentation } = await import('@/state/presentation')

    expect(usePresentation.getState().mode).toBe('compatibility')
    usePresentation.getState().choose('advanced')

    expect(usePresentation.getState().mode).toBe('advanced')
    expect(localStorage.setItem).toHaveBeenCalledWith('dsh-studio.presentation', 'advanced')
    expect(shared.announce).toHaveBeenCalledWith('presentation')
  })

  it('restores the additive extended mode across windows', async () => {
    stored.set('dsh-studio.presentation', 'extended')
    vi.resetModules()
    const { usePresentation } = await import('@/state/presentation')
    expect(usePresentation.getState().mode).toBe('extended')
  })
})

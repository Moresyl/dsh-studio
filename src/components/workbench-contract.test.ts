import { afterEach, describe, expect, it, vi } from 'vitest'

const loadContract = async () => {
  vi.resetModules()
  vi.stubGlobal('navigator', { userAgent: 'Windows NT' })
  vi.stubGlobal('window', {})
  return import('@/components/workbench-contract')
}

afterEach(() => vi.unstubAllGlobals())

describe('workbench navigation contract', () => {
  it('keeps every numbered page in its stable shortcut order', async () => {
    const { VIEWS } = await loadContract()
    expect(VIEWS.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'console', label: 'nav.console' },
      { id: 'terminal', label: 'nav.terminal' },
      { id: 'sessions', label: 'nav.sessions' },
      { id: 'plugins', label: 'nav.plugins' },
      { id: 'remote', label: 'nav.remote' },
      { id: 'about', label: 'nav.about' },
      { id: 'presentations', label: 'nav.presentations' },
      { id: 'workspaces', label: 'nav.workspaces' },
      { id: 'library', label: 'nav.library' },
    ])
  })

  it('keeps settings outside the numbered page sequence', async () => {
    const { SETTINGS, VIEWS } = await loadContract()
    expect(SETTINGS).toMatchObject({ id: 'settings', label: 'nav.settings' })
    expect(VIEWS.some(({ id }) => id === SETTINGS.id)).toBe(false)
  })
})

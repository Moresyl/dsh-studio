import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const xterm = vi.hoisted(() => ({
  constructedWith: vi.fn(),
  unicodeActivated: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ readText: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@/lib/i18n', () => ({ t: vi.fn((key: string) => key) }))
vi.mock('@/lib/ipc', () => ({
  terminalResize: vi.fn(),
  terminalWrite: vi.fn(),
}))
vi.mock('@/lib/platform', () => ({ isMac: false, isWindows: true }))
vi.mock('@/lib/terminal-shortcuts', () => ({ clipboardAction: vi.fn(() => null) }))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    activate(terminal: { options: { allowProposedApi?: boolean } }): void {
      if (!terminal.options.allowProposedApi) {
        throw new Error('You must set the allowProposedApi option to true to use proposed API')
      }
      xterm.unicodeActivated()
    }
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

vi.mock('@xterm/xterm', () => {
  class TerminalMock {
    readonly cols = 80
    readonly rows = 24
    readonly unicode = { activeVersion: '6' }
    readonly options: Record<string, unknown>

    constructor(options: Record<string, unknown>) {
      this.options = options
      xterm.constructedWith(options)
    }

    loadAddon(addon: { activate?: (terminal: TerminalMock) => void }): void {
      addon.activate?.(this)
    }

    attachCustomKeyEventHandler(): void {}

    open(): void {}
  }

  return { Terminal: TerminalMock }
})

import { open } from '@/lib/screen'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name === '--font-mono' ? 'monospace' : '#000'),
  }))
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({ style: {}, remove: vi.fn() }),
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('terminal creation', () => {
  it('opts into xterm proposed APIs before the Unicode 11 addon activates', () => {
    const appendChild = vi.fn()

    const result = open({ appendChild } as unknown as HTMLElement)

    expect(xterm.constructedWith).toHaveBeenCalledWith(
      expect.objectContaining({ allowProposedApi: true }),
    )
    expect(xterm.unicodeActivated).toHaveBeenCalledOnce()
    expect(result.screen.terminal.unicode.activeVersion).toBe('11')
    expect(result).toMatchObject({ rows: 24, cols: 80 })
    expect(appendChild).toHaveBeenCalledOnce()
  })
})

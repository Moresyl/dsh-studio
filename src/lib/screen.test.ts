import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const xterm = vi.hoisted(() => ({
  constructedWith: vi.fn(),
  unicodeActivated: vi.fn(),
  data: null as ((data: string) => void) | null,
  resize: null as ((size: { rows: number; cols: number }) => void) | null,
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
    write(): void {}
    dispose(): void {}
    onData(handler: (data: string) => void): void {
      xterm.data = handler
    }
    onResize(handler: (size: { rows: number; cols: number }) => void): void {
      xterm.resize = handler
    }
  }

  return { Terminal: TerminalMock }
})

import { adopt, dispose, open, reportProblemsTo, retire } from '@/lib/screen'
import * as ipc from '@/lib/ipc'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ipc.terminalWrite).mockResolvedValue(undefined)
  vi.mocked(ipc.terminalResize).mockResolvedValue(undefined)
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => (name === '--font-mono' ? 'monospace' : '#000'),
  }))
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => ({ style: {}, remove: vi.fn() }),
  })
})

afterEach(() => {
  dispose('test-shell')
  vi.unstubAllGlobals()
})

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

describe('terminal transcript lifecycle', () => {
  const attach = () => {
    const { screen } = open({ appendChild: vi.fn() } as unknown as HTMLElement)
    adopt('test-shell', screen)
  }

  it('sends input and resize events only while the shell is live', () => {
    attach()
    xterm.data?.('echo hello\r')
    xterm.resize?.({ rows: 30, cols: 90 })
    expect(ipc.terminalWrite).toHaveBeenCalledExactlyOnceWith('test-shell', 'echo hello\r')
    expect(ipc.terminalResize).toHaveBeenCalledExactlyOnceWith('test-shell', 30, 90)
    retire('test-shell', 1)
    xterm.data?.('ignored')
    xterm.resize?.({ rows: 40, cols: 100 })
    expect(ipc.terminalWrite).toHaveBeenCalledOnce()
    expect(ipc.terminalResize).toHaveBeenCalledOnce()
  })

  it('suppresses a late native failure after exit, but reports failures while live', async () => {
    const report = vi.fn()
    reportProblemsTo(report)
    attach()
    vi.mocked(ipc.terminalResize).mockRejectedValue('resize failed')
    xterm.resize?.({ rows: 30, cols: 90 })
    await Promise.resolve()
    expect(report).toHaveBeenCalledExactlyOnceWith('resize failed')
    report.mockClear()
    xterm.resize?.({ rows: 40, cols: 100 })
    retire('test-shell', 1)
    await Promise.resolve()
    expect(report).not.toHaveBeenCalled()
  })

  it('does not send or report events from a disposed emulator', async () => {
    const report = vi.fn()
    reportProblemsTo(report)
    attach()
    vi.mocked(ipc.terminalWrite).mockRejectedValue('closed')
    xterm.data?.('before closing')
    dispose('test-shell')
    xterm.data?.('after closing')
    xterm.resize?.({ rows: 30, cols: 90 })
    await Promise.resolve()
    expect(ipc.terminalWrite).toHaveBeenCalledOnce()
    expect(ipc.terminalResize).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })
})

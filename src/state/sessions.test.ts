import { save as pickPath } from '@tauri-apps/plugin-dialog'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { SessionCard, SessionExport, SessionTranscript } from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
import { useSessions } from '@/state/sessions'

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }))
vi.mock('@/lib/ipc')

const card = (title: string): SessionCard => ({
  id: 'session-1',
  project: 'D:\\work',
  started: 1,
  touched: 2,
  title,
  turns: 1,
  models: ['deepseek-chat'],
  tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  byModel: [],
  delegated: false,
  bytes: 10,
})

const transcript = (title: string): SessionTranscript => ({ card: card(title), lines: [] })
const rendered: SessionExport = { name: 'session.md', text: '# Session' }

beforeEach(() => {
  vi.clearAllMocks()
  useDialog.setState({ pending: null })
  useSessions.setState({
    cards: null,
    hits: null,
    query: '',
    project: null,
    opened: null,
    opening: null,
    scanning: false,
    searching: false,
    exporting: false,
    error: null,
  })
  vi.mocked(ipc.sessionExport).mockResolvedValue(rendered)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

describe('session reads', () => {
  it('runs only one shelf refresh while the first is in flight', async () => {
    let finish!: (answer: { cards: SessionCard[]; loaded: number }) => void
    vi.mocked(ipc.sessionRoster).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    const first = useSessions.getState().refresh()
    await useSessions.getState().refresh()

    expect(ipc.sessionRoster).toHaveBeenCalledOnce()
    finish({ cards: [card('current')], loaded: 1 })
    await first
  })

  it('keeps the newest snapshot when the same session is reopened', async () => {
    let finishOld!: (answer: SessionTranscript) => void
    vi.mocked(ipc.sessionRead)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve
        }),
      )
      .mockResolvedValueOnce(transcript('new snapshot'))

    const old = useSessions.getState().open('session-1')
    await useSessions.getState().open('session-1')
    finishOld(transcript('old snapshot'))
    await old

    expect(useSessions.getState().opened?.card.title).toBe('new snapshot')
    expect(useSessions.getState().opening).toBeNull()
  })

  it('ignores a read that finishes after the reader was closed', async () => {
    let finish!: (answer: SessionTranscript) => void
    vi.mocked(ipc.sessionRead).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    const reading = useSessions.getState().open('session-1')
    useSessions.getState().close()
    finish(transcript('late'))
    await reading

    expect(useSessions.getState().opened).toBeNull()
  })
})

describe('session exports', () => {
  it('refuses a second export while the first render is in flight', async () => {
    let finish!: (answer: SessionExport) => void
    vi.mocked(ipc.sessionExport).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    const first = useSessions.getState().copyOut('session-1', 'markdown')
    await expect(useSessions.getState().saveOut('session-1', 'html', 'HTML')).resolves.toBe(false)

    expect(ipc.sessionExport).toHaveBeenCalledOnce()
    expect(pickPath).not.toHaveBeenCalled()
    finish(rendered)
    await first
  })

  it('reports a native save-dialog failure instead of rejecting', async () => {
    vi.mocked(pickPath).mockRejectedValue('save dialog unavailable')

    await expect(useSessions.getState().saveOut('session-1', 'markdown', 'Markdown')).resolves.toBe(
      false,
    )

    expect(useSessions.getState().error).toBe('save dialog unavailable')
    expect(ipc.sessionSave).not.toHaveBeenCalled()
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'save dialog unavailable',
    })
  })

  it('reports a clipboard refusal globally and returns false', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce('clipboard permission denied')

    await expect(useSessions.getState().copyOut('session-1', 'markdown')).resolves.toBe(false)

    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'clipboard permission denied',
    })
  })
})

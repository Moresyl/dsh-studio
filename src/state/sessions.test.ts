import { save as pickPath } from '@tauri-apps/plugin-dialog'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { SessionCard, SessionExport, SessionTranscript } from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
import { projects, spent, useSessions } from '@/state/sessions'

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
  vi.resetAllMocks()
  useDialog.setState({ pending: null })
  useSessions.setState({
    cards: null,
    archived: [],
    hits: null,
    query: '',
    project: null,
    opened: null,
    opening: null,
    scanning: false,
    archiving: null,
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
  it('reports a current shelf failure and clears its busy state', async () => {
    vi.mocked(ipc.sessionRoster).mockRejectedValueOnce(new Error('shelf unavailable'))
    await useSessions.getState().refresh()
    expect(useSessions.getState()).toMatchObject({ scanning: false, error: 'shelf unavailable' })
    expect(useDialog.getState().pending).toBeNull()
  })

  it('reports a current transcript failure without reopening after close', async () => {
    vi.mocked(ipc.sessionRead).mockRejectedValueOnce(new Error('transcript missing'))
    await useSessions.getState().open('missing')
    expect(useSessions.getState()).toMatchObject({
      opening: null,
      opened: null,
      error: 'transcript missing',
    })
    useSessions.getState().close()
    expect(useSessions.getState().error).toBeNull()
  })
  it('serializes archive writes and releases the busy state after failure', async () => {
    let reject!: (cause: Error) => void
    vi.mocked(ipc.sessionArchive).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail
      }),
    )
    const first = useSessions.getState().archive('session-1', true)
    expect(useSessions.getState().archiving).toBe('session-1')
    await expect(useSessions.getState().archive('session-2', true)).resolves.toBe(false)
    expect(ipc.sessionArchive).toHaveBeenCalledOnce()
    reject(new Error('archive write failed'))
    await expect(first).resolves.toBe(false)
    expect(useSessions.getState().archiving).toBeNull()
    expect(useSessions.getState().archived).toEqual([])
  })
  it('does not lose an archive update when an older shelf read finishes', async () => {
    let finish!: (value: Awaited<ReturnType<typeof ipc.sessionRoster>>) => void
    vi.mocked(ipc.sessionRoster).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    vi.mocked(ipc.sessionArchive).mockResolvedValueOnce({
      cards: [card('archived')],
      loaded: 1,
      archived: ['session-1'],
    })
    const refreshing = useSessions.getState().refresh()
    await useSessions.getState().archive('session-1', true)
    finish({ cards: [card('old')], loaded: 1, archived: [] })
    await refreshing
    expect(useSessions.getState().archived).toEqual(['session-1'])
    expect(useSessions.getState().scanning).toBe(false)
  })

  it('drops an obsolete shelf error after archiving and permits the next refresh', async () => {
    let reject!: (cause: Error) => void
    vi.mocked(ipc.sessionRoster).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail
      }),
    )
    vi.mocked(ipc.sessionArchive).mockResolvedValueOnce({
      cards: [card('archived')],
      loaded: 1,
      archived: ['session-1'],
    })
    const old = useSessions.getState().refresh()
    await useSessions.getState().archive('session-1', true)
    reject(new Error('obsolete shelf failure'))
    await old
    expect(useSessions.getState().error).toBeNull()
    vi.mocked(ipc.sessionRoster).mockResolvedValueOnce({
      cards: [card('fresh')],
      loaded: 1,
      archived: ['session-1'],
    })
    await useSessions.getState().refresh()
    expect(useSessions.getState().cards?.[0]?.title).toBe('fresh')
  })
  it('runs only one shelf refresh while the first is in flight', async () => {
    let finish!: (answer: { cards: SessionCard[]; loaded: number; archived: string[] }) => void
    vi.mocked(ipc.sessionRoster).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    const first = useSessions.getState().refresh()
    await useSessions.getState().refresh()

    expect(ipc.sessionRoster).toHaveBeenCalledOnce()
    finish({ cards: [card('current')], loaded: 1, archived: [] })
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

  it('updates the shelf only after native archive state was saved', async () => {
    vi.mocked(ipc.sessionArchive).mockResolvedValue({
      cards: [card('archived')],
      loaded: 1,
      archived: ['session-1'],
    })

    await expect(useSessions.getState().archive('session-1', true)).resolves.toBe(true)

    expect(ipc.sessionArchive).toHaveBeenCalledWith('session-1', true)
    expect(useSessions.getState().archived).toEqual(['session-1'])
    expect(useSessions.getState().cards?.at(0)?.title).toBe('archived')
  })
})

describe('session exports', () => {
  it('copies rendered text and writes only to the explicitly selected save path', async () => {
    await expect(useSessions.getState().copyOut('session-1', 'markdown')).resolves.toBe(true)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(rendered.text)
    vi.mocked(pickPath).mockResolvedValueOnce('D:/exports/session.md')
    await expect(useSessions.getState().saveOut('session-1', 'markdown', 'Markdown')).resolves.toBe(
      true,
    )
    expect(pickPath).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'session.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      }),
    )
    expect(ipc.sessionSave).toHaveBeenCalledWith('D:/exports/session.md', rendered.text)
  })

  it('does not write or report an error when the save dialog is cancelled', async () => {
    vi.mocked(pickPath).mockResolvedValueOnce(null)
    await expect(useSessions.getState().saveOut('session-1', 'markdown', 'Markdown')).resolves.toBe(
      false,
    )
    expect(ipc.sessionSave).not.toHaveBeenCalled()
    expect(useDialog.getState().pending).toBeNull()
  })

  it('reports write failure and leaves exporting clear', async () => {
    vi.mocked(pickPath).mockResolvedValueOnce('D:/exports/session.md')
    vi.mocked(ipc.sessionSave).mockRejectedValueOnce(new Error('disk full'))
    await expect(useSessions.getState().saveOut('session-1', 'markdown', 'Markdown')).resolves.toBe(
      false,
    )
    expect(useSessions.getState()).toMatchObject({ exporting: false, error: 'disk full' })
  })

  it.each(['copy', 'save'] as const)('does not %s after rendering fails', async (action) => {
    vi.mocked(ipc.sessionExport).mockRejectedValueOnce(new Error('invalid session'))
    const store = useSessions.getState()
    const result =
      action === 'copy'
        ? await store.copyOut('session-1', 'markdown')
        : await store.saveOut('session-1', 'markdown', 'Markdown')
    expect(result).toBe(false)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(pickPath).not.toHaveBeenCalled()
    expect(useSessions.getState()).toMatchObject({ exporting: false, error: 'invalid session' })
  })

  it('ignores both export actions while a render is already in flight', async () => {
    useSessions.setState({ exporting: true })
    await expect(useSessions.getState().copyOut('session-1', 'markdown')).resolves.toBe(false)
    await expect(useSessions.getState().saveOut('session-1', 'markdown', 'Markdown')).resolves.toBe(
      false,
    )
    expect(ipc.sessionExport).not.toHaveBeenCalled()
  })
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

describe('session search and summaries', () => {
  it('searches the chosen project and clears empty queries without an IPC call', async () => {
    vi.mocked(ipc.sessionSearch).mockResolvedValue([])
    await useSessions.getState().search('needle')
    expect(ipc.sessionSearch).toHaveBeenLastCalledWith('needle', undefined)
    await useSessions.getState().narrow('D:/work/project')
    expect(ipc.sessionSearch).toHaveBeenLastCalledWith('needle', 'D:/work/project')
    await useSessions.getState().search('  ')
    expect(ipc.sessionSearch).toHaveBeenCalledTimes(2)
    expect(useSessions.getState()).toMatchObject({ hits: null, searching: false })
  })

  it('does not show stale search success or failure after the query is cleared', async () => {
    let finish!: (value: ipc.SessionHit[]) => void
    vi.mocked(ipc.sessionSearch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const first = useSessions.getState().search('old')
    await useSessions.getState().search('')
    finish([{ card: card('obsolete'), matches: 1, marks: [] }])
    await first
    expect(useSessions.getState().hits).toBeNull()
    let reject!: (cause: Error) => void
    vi.mocked(ipc.sessionSearch).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail
      }),
    )
    const second = useSessions.getState().search('old')
    await useSessions.getState().search('')
    reject(new Error('obsolete error'))
    await second
    expect(useSessions.getState()).toMatchObject({ hits: null, error: null, searching: false })
  })

  it('shows a current search error inline and can request search from the archive tab', async () => {
    vi.mocked(ipc.sessionSearch).mockRejectedValueOnce(new Error('search failed'))
    await useSessions.getState().search('needle')
    expect(useSessions.getState()).toMatchObject({
      hits: [],
      error: 'search failed',
      searching: false,
    })
    useSessions.getState().setTab('archived')
    const before = useSessions.getState().searchRequest
    useSessions.getState().requestSearch()
    expect(useSessions.getState()).toMatchObject({ tab: 'list', searchRequest: before + 1 })
  })

  it('deduplicates project paths in shelf order and sums every token class', () => {
    const cards = [
      card('first'),
      { ...card('second'), project: '' },
      card('third'),
      {
        ...card('fourth'),
        project: 'D:/another',
        tokens: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6 },
      },
    ]
    expect(projects(cards)).toEqual(['D:\\work', 'D:/another'])
    expect(spent(cards)).toEqual({ input: 6, output: 10, cacheRead: 5, cacheWrite: 6 })
    expect(projects([])).toEqual([])
    expect(spent([])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

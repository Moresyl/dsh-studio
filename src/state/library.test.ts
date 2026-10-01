import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ipc from '@/lib/ipc'
import {
  annotationFor,
  annotationMatches,
  emptyAnnotation,
  organizeSessions,
  parseTags,
  validTags,
  sessionTitle,
  useLibrary,
} from '@/state/library'
import type { PersonalLibrary, SessionCard } from '@/lib/ipc'
vi.mock('@/lib/ipc')
vi.mock('@/state/failure', () => ({ reportFailure: (cause: unknown) => String(cause) }))
const snapshot = (): PersonalLibrary => ({ version: 1, sessions: {}, prompts: {} })
const card = (id: string, touched: number): SessionCard =>
  ({ id, title: id, touched }) as SessionCard
beforeEach(() => {
  vi.resetAllMocks()
  useLibrary.setState({ data: snapshot(), loaded: false, loading: false, busy: false, error: null })
})
describe('durable personal library', () => {
  it('serializes batch changes and restores with the exact reviewed revision', async () => {
    const preview = {
      revision: 'reviewed',
      sourceHash: 'content',
      prompts: 1,
      sessions: 0,
      conflicts: 1,
      names: ['Review'],
      promptsOnly: true,
    }
    expect(await useLibrary.getState().annotateMany(['one'], { pinned: true })).toBe(false)
    expect(await useLibrary.getState().importData('{}', preview, false)).toBe(false)
    useLibrary.setState({ loaded: true })
    vi.mocked(ipc.sessionAnnotateMany).mockResolvedValue(snapshot())
    expect(await useLibrary.getState().annotateMany(['one', 'two'], { addTags: ['review'] })).toBe(
      true,
    )
    expect(ipc.sessionAnnotateMany).toHaveBeenCalledWith(['one', 'two'], { addTags: ['review'] })
    vi.mocked(ipc.libraryImportApply).mockResolvedValue(snapshot())
    expect(await useLibrary.getState().importData('{}', preview, false)).toBe(true)
    expect(ipc.libraryImportApply).toHaveBeenCalledWith('{}', preview, false)
    vi.mocked(ipc.libraryImportApply).mockRejectedValue(new Error('stale preview'))
    expect(await useLibrary.getState().importData('{}', preview, true)).toBe(false)
    expect(useLibrary.getState()).toMatchObject({ busy: false, error: 'Error: stale preview' })
  })
  it('loads once at a time and exposes recoverable read errors', async () => {
    let resolve!: (data: PersonalLibrary) => void
    vi.mocked(ipc.libraryRead).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const load = useLibrary.getState().load()
    await useLibrary.getState().load()
    expect(ipc.libraryRead).toHaveBeenCalledTimes(1)
    resolve(snapshot())
    await load
    expect(useLibrary.getState()).toMatchObject({ loaded: true, loading: false })
    vi.mocked(ipc.libraryRead).mockRejectedValue(new Error('damaged file'))
    await useLibrary.getState().load()
    expect(useLibrary.getState().error).toBe('damaged file')
  })
  it('does not write before a successful read', async () => {
    expect(await useLibrary.getState().annotate('one', { pinned: true })).toBe(false)
    expect(ipc.sessionAnnotate).not.toHaveBeenCalled()
  })
  it('merges patches and serializes writes without optimistic data loss', async () => {
    const data = snapshot()
    data.sessions.one = { ...emptyAnnotation(), note: 'keep me' }
    useLibrary.setState({ data, loaded: true })
    let resolve!: (data: PersonalLibrary) => void
    vi.mocked(ipc.sessionAnnotate).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const write = useLibrary.getState().annotate('one', { pinned: true })
    expect(ipc.sessionAnnotate).toHaveBeenCalledWith('one', { pinned: true })
    expect(await useLibrary.getState().removePrompt('x')).toBe(false)
    await useLibrary.getState().load()
    expect(ipc.libraryRead).not.toHaveBeenCalled()
    resolve(data)
    expect(await write).toBe(true)
    expect(useLibrary.getState().busy).toBe(false)
  })
  it('creates blank annotations and handles rejected mutations', async () => {
    useLibrary.setState({ loaded: true })
    vi.mocked(ipc.sessionAnnotate).mockResolvedValue(snapshot())
    expect(await useLibrary.getState().annotate('new', { title: 'name' })).toBe(true)
    expect(ipc.sessionAnnotate).toHaveBeenCalledWith('new', { title: 'name' })
    const prompt = { id: 'one', title: 'Review', body: 'Review code', tags: [] }
    vi.mocked(ipc.promptSave).mockResolvedValue(snapshot())
    expect(await useLibrary.getState().savePrompt(prompt)).toBe(true)
    vi.mocked(ipc.promptRemove).mockRejectedValue(new Error('disk full'))
    expect(await useLibrary.getState().removePrompt('one')).toBe(false)
    expect(useLibrary.getState()).toMatchObject({ busy: false, error: 'Error: disk full' })
  })
})
describe('session organization', () => {
  const annotations = {
    z: { ...emptyAnnotation(), pinned: true, title: 'Alpha', tags: ['release'], note: 'decision' },
  }
  const cards: [SessionCard, SessionCard, SessionCard] = [
    card('b', 20),
    card('z', 1),
    card('a', 10),
  ]
  it('sorts pins first, keeps the source untouched, filters tags and pins', () => {
    expect(organizeSessions(cards, annotations).map((item) => item.id)).toEqual(['z', 'b', 'a'])
    expect(cards[0].id).toBe('b')
    expect(
      organizeSessions(cards, annotations, { pinned: true, tag: 'release' }).map((item) => item.id),
    ).toEqual(['z'])
    expect(organizeSessions(cards, annotations, { tag: 'missing' })).toEqual([])
    expect(
      organizeSessions(cards, annotations, { order: 'oldest' }).map((item) => item.id),
    ).toEqual(['z', 'a', 'b'])
    expect(organizeSessions(cards, annotations, { order: 'title' }).map((item) => item.id)).toEqual(
      ['z', 'a', 'b'],
    )
    expect(organizeSessions([card('b', 0), card('a', 0)], {}).map((item) => item.id)).toEqual([
      'a',
      'b',
    ])
  })
  it('matches all annotation terms, handles empty data and deduplicates tags', () => {
    expect(sessionTitle(cards[1], annotations)).toBe('Alpha')
    expect(sessionTitle(cards[0], annotations)).toBe('b')
    expect(annotationMatches(cards[1], annotations, 'ALPHA decision')).toBe(true)
    expect(annotationMatches(cards[1], annotations, 'release missing')).toBe(false)
    expect(annotationMatches(cards[0], annotations, 'b')).toBe(false)
    expect(annotationMatches(cards[1], annotations, '  ')).toBe(false)
    expect(parseTags(' code， review,code, , ')).toEqual(['code', 'review'])
    const overflow = Array.from({ length: 20 }, (_, i) => String(i)).join(',')
    expect(parseTags(overflow).length).toBe(20)
    expect(validTags(overflow)).toBe(false)
    expect(validTags('代码，审阅,代码')).toBe(true)
    expect(validTags('😀'.repeat(40))).toBe(true)
    expect(validTags('😀'.repeat(41))).toBe(false)
    expect(validTags('bad\u0000tag')).toBe(false)
  })

  it('never treats inherited object properties as session annotations', () => {
    for (const id of ['constructor', '__proto__', 'toString']) {
      expect(annotationFor({}, id)).toBeUndefined()
      expect(sessionTitle(card(id, 0), {})).toBe(id)
      expect(annotationMatches(card(id, 0), {}, 'note')).toBe(false)
      expect(organizeSessions([card(id, 0)], {}, { tag: 'release' })).toEqual([])
      const own = JSON.parse(JSON.stringify({ [id]: { ...emptyAnnotation(), title: 'Saved' } }))
      expect(sessionTitle(card(id, 0), own)).toBe('Saved')
    }
  })
})

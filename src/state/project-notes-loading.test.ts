import { expect, it, vi } from 'vitest'
import { t } from '@/lib/i18n'

vi.mock('./project-notes-actions', () => {
  throw new Error('editor chunk unavailable')
})

it('reports a failed editor load without rejecting UI actions or dropping a draft', async () => {
  const { useProjectNotes: store } = await import('./project-notes')
  expect(await store.getState().save()).toBe(true)
  expect(await store.getState().load()).toBe(false)
  expect(store.getState().error).toBe(t('notes.loadFailed'))
  const draft = { id: 'unsaved', title: 'Keep', body: 'Draft text', revision: 0 }
  store.setState({ draft, saved: null })
  expect(await store.getState().save()).toBe(false)
  expect(store.getState().draft).toEqual(draft)
  expect(store.getState().lock()).toBe(false)
  expect(await store.getState().choose(null)).toBe(false)
  expect(await store.getState().remove('unsaved')).toBe(false)
  expect(await store.getState().recover('editor')).toBe(false)
  expect(await store.getState().discardDraft('editor')).toBe(false)
  expect(await store.getState().saveCopy()).toBe(false)
  expect(store.getState().discard(draft)).toBe(false)
})

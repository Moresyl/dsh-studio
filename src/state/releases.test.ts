import { beforeEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  applicationVersions: vi.fn(),
  reviewVersion: vi.fn(),
  discardReview: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ({ applicationVersions: api.applicationVersions }))
vi.mock('@/lib/updater', () => ({
  reviewVersion: api.reviewVersion,
  discardReview: api.discardReview,
}))

import type {
  ApplicationReleasePage,
  ApplicationReleaseSummary,
  ApplicationReleaseReview,
} from '@/lib/ipc'
import { useReleaseHistory } from '@/state/releases'

const entry = (version = '0.9.19', hasUpdater = true): ApplicationReleaseSummary => ({
  version,
  hasUpdater,
  title: version,
  direction: 'current',
  published: '2026-09-29',
  url: `https://github.com/Moresyl/dsh-studio/releases/tag/v${version}`,
})
const review = (version = '0.9.19'): ApplicationReleaseReview => ({
  ...entry(version),
  currentVersion: '0.9.19',
  reviewId: version,
  fingerprint: 'f',
  notes: 'Notes',
  bytes: 100,
  artifact: 'Studio.exe',
  canInstall: true,
  installBlock: null,
})
const page = (version = '0.9.19', number = 1): ApplicationReleasePage => ({
  releases: [entry(version)],
  page: number,
  hasMore: true,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useReleaseHistory.getState().dispose()
  vi.clearAllMocks()
  api.applicationVersions.mockResolvedValue(page())
  api.reviewVersion.mockImplementation(async (version) => review(version))
  api.discardReview.mockResolvedValue(undefined)
})

it('loads a page and reviews its first release', async () => {
  await useReleaseHistory.getState().load()
  expect(useReleaseHistory.getState()).toMatchObject({
    page: 1,
    hasMore: true,
    selected: '0.9.19',
    review: review(),
    loading: false,
    reviewing: false,
  })
})

it('does not invent a selection for an empty page', async () => {
  api.applicationVersions.mockResolvedValue({ releases: [], page: 2, hasMore: false })
  await useReleaseHistory.getState().load(2)
  expect(useReleaseHistory.getState()).toMatchObject({
    page: 2,
    selected: null,
    review: null,
    hasMore: false,
  })
  expect(api.reviewVersion).not.toHaveBeenCalled()
})

it('keeps an old page after a failed refresh and supports retry', async () => {
  await useReleaseHistory.getState().load()
  api.applicationVersions.mockRejectedValueOnce(new Error('offline'))
  await useReleaseHistory.getState().load(2)
  expect(useReleaseHistory.getState()).toMatchObject({
    page: 1,
    error: 'offline',
    loading: false,
    review: null,
  })
  api.applicationVersions.mockResolvedValue(page('0.9.18', 2))
  await useReleaseHistory.getState().load(2)
  expect(useReleaseHistory.getState()).toMatchObject({ page: 2, error: null, selected: '0.9.18' })
})

it('ignores stale page responses and errors after a newer request', async () => {
  const old = deferred<ApplicationReleasePage>()
  api.applicationVersions.mockReturnValueOnce(old.promise)
  const first = useReleaseHistory.getState().load(1)
  api.applicationVersions.mockResolvedValue(page('0.9.18', 2))
  await useReleaseHistory.getState().load(2)
  old.resolve(page('0.9.17'))
  await first
  expect(useReleaseHistory.getState().page).toBe(2)
  const failure = deferred<ApplicationReleasePage>()
  api.applicationVersions.mockReturnValueOnce(failure.promise)
  const pending = useReleaseHistory.getState().load(3)
  await useReleaseHistory.getState().load(2)
  failure.reject(new Error('stale failure'))
  await pending
  expect(useReleaseHistory.getState().error).toBeNull()
})

it('discards late reviews, including reopening the same version', async () => {
  useReleaseHistory.setState({ entries: [entry()] })
  const old = deferred<ApplicationReleaseReview>()
  api.reviewVersion.mockReturnValueOnce(old.promise)
  const pending = useReleaseHistory.getState().select('0.9.19')
  const fresh = { ...review(), reviewId: 'fresh' }
  api.reviewVersion.mockResolvedValue(fresh)
  await useReleaseHistory.getState().select('0.9.19')
  old.resolve({ ...review(), reviewId: 'old' })
  await pending
  expect(useReleaseHistory.getState().review?.reviewId).toBe('fresh')
  expect(api.discardReview).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 'old' }))
})

it('reports only the current review failure and permits a retry', async () => {
  useReleaseHistory.setState({ entries: [entry(), entry('0.9.18')] })
  const old = deferred<ApplicationReleaseReview>()
  api.reviewVersion.mockReturnValueOnce(old.promise)
  const pending = useReleaseHistory.getState().select('0.9.18')
  api.reviewVersion.mockRejectedValueOnce(new Error('signature unavailable'))
  await useReleaseHistory.getState().select('0.9.19')
  old.reject(new Error('stale failure'))
  await pending
  expect(useReleaseHistory.getState()).toMatchObject({
    reviewError: 'signature unavailable',
    reviewing: false,
  })
  api.reviewVersion.mockResolvedValue(review())
  await useReleaseHistory.getState().select('0.9.19')
  expect(useReleaseHistory.getState().reviewError).toBeNull()
})

it('does not review absent versions or releases without an updater', async () => {
  useReleaseHistory.setState({ entries: [entry('0.9.18', false)] })
  await useReleaseHistory.getState().select('9.9.9')
  expect(useReleaseHistory.getState().selected).toBeNull()
  await useReleaseHistory.getState().select('0.9.18')
  expect(useReleaseHistory.getState()).toMatchObject({
    selected: '0.9.18',
    reviewing: false,
    review: null,
  })
  useReleaseHistory.setState({ loading: true })
  await useReleaseHistory.getState().select('0.9.18')
  expect(api.reviewVersion).not.toHaveBeenCalled()
})

it('closing the history invalidates pending work and releases its receipts', async () => {
  await useReleaseHistory.getState().load()
  const old = deferred<ApplicationReleaseReview>()
  api.reviewVersion.mockReturnValueOnce(old.promise)
  const pending = useReleaseHistory.getState().select('0.9.19')
  useReleaseHistory.getState().dispose()
  old.resolve(review())
  await pending
  expect(useReleaseHistory.getState()).toMatchObject({ entries: [], review: null, selected: null })
  expect(api.discardReview).toHaveBeenCalledWith(review())
})

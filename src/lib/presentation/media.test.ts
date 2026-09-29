import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({
  open: vi.fn(),
  presentationImageImport: vi.fn(),
  presentationImageRead: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: api.open }))
vi.mock('@/lib/ipc', () => api)
import { imageElement, imageFixture } from './image.test-support'
import { fixture } from './fixtures.test-support'
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
})
afterEach(() => vi.useRealTimers())

it('deduplicates in-flight reads, caches previews and refreshes source verification', async () => {
  const media = await import('./media'),
    image = imageFixture()
  let resolve!: (value: typeof image) => void
  api.presentationImageRead.mockReturnValue(
    new Promise((yes) => {
      resolve = yes
    }),
  )
  const a = media.readImage(image.id),
    b = media.readImage(image.id)
  expect(api.presentationImageRead).toHaveBeenCalledOnce()
  resolve(image)
  await Promise.all([a, b])
  await media.readImage(image.id)
  expect(api.presentationImageRead).toHaveBeenCalledOnce()
  await media.readImage(image.id, true)
  expect(api.presentationImageRead).toHaveBeenCalledTimes(2)
  await expect(media.readImage('../private')).rejects.toThrow('identity')
})

it('handles picker cancellation, invalid responses and native failures without creating a document', async () => {
  const media = await import('./media'),
    image = imageFixture()
  api.open
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(['a', 'b'])
    .mockResolvedValue('selected.png')
  expect(await media.choosePresentationImage()).toBeNull()
  await expect(media.choosePresentationImage()).rejects.toThrow('one image')
  api.presentationImageImport.mockRejectedValueOnce(Error('decode failed')).mockResolvedValue(image)
  await expect(media.choosePresentationImage()).rejects.toThrow('decode failed')
  expect(await media.choosePresentationImage()).toEqual(image)
  expect(await media.readImage(image.id)).toEqual(image)
  expect(api.presentationImageRead).not.toHaveBeenCalled()
})

it('reads only distinct referenced images and cancels waiting immediately', async () => {
  const media = await import('./media'),
    image = imageFixture(),
    doc = fixture()
  doc.version = 2
  doc.slides[0]!.elements = [imageElement(image), { ...imageElement(image), id: 'copy' }]
  api.presentationImageRead.mockResolvedValue(image)
  expect(await media.documentImages(doc)).toEqual({ [image.id]: image })
  expect(api.presentationImageRead).toHaveBeenCalledOnce()
  let resolve!: (value: typeof image) => void
  api.presentationImageRead.mockReturnValue(
    new Promise((yes) => {
      resolve = yes
    }),
  )
  const controller = new AbortController()
  const operation = media.documentImages(doc, controller.signal)
  controller.abort()
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  resolve(image)
})

it('bounds silent native reads and permits retry after failure', async () => {
  vi.useFakeTimers()
  const media = await import('./media'),
    image = imageFixture()
  api.presentationImageRead.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(image)
  const first = expect(media.readImage(image.id)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(30_000)
  await first
  expect(await media.readImage(image.id)).toEqual(image)
  expect(vi.getTimerCount()).toBe(0)
})

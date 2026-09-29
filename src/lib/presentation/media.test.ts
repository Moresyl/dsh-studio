import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
const api = vi.hoisted(() => ({
  open: vi.fn(),
  presentationImageImport: vi.fn(),
  presentationImageImportAttachment: vi.fn(),
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
    image = imageFixture(),
    document = fixture()
  api.open
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(['a', 'b'])
    .mockResolvedValue('selected.png')
  expect(await media.choosePresentationImage(document)).toBeNull()
  await expect(media.choosePresentationImage(document)).rejects.toThrow('one image')
  api.presentationImageImport.mockRejectedValueOnce(Error('decode failed')).mockResolvedValue(image)
  await expect(media.choosePresentationImage(document)).rejects.toThrow('decode failed')
  expect(await media.choosePresentationImage(document)).toEqual(image)
  expect(api.presentationImageImport).toHaveBeenLastCalledWith('selected.png', document)
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

it('imports one bounded session-authorized blob and caches the normalized asset', async () => {
  const media = await import('./media'),
    image = imageFixture(),
    raw = Uint8Array.from([0, 255, 128, 64]),
    attachment = `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    document = fixture()
  api.presentationImageImportAttachment.mockResolvedValue(image)
  expect(await media.importPresentationAttachment(attachment, new Blob([raw]), document)).toEqual(
    image,
  )
  expect(api.presentationImageImportAttachment).toHaveBeenCalledWith(
    attachment,
    'AP+AQA==',
    document,
  )
  expect(await media.readImage(image.id)).toEqual(image)
  expect(api.presentationImageRead).not.toHaveBeenCalled()
  await expect(
    media.importPresentationAttachment('invalid', new Blob([raw]), document),
  ).rejects.toThrow('identity')
  await expect(
    media.importPresentationAttachment(attachment, new Blob([]), document),
  ).rejects.toThrow('16 MiB')
  await expect(
    media.importPresentationAttachment(
      attachment,
      new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]),
      document,
    ),
  ).rejects.toThrow('16 MiB')
  expect(api.presentationImageImportAttachment).toHaveBeenCalledOnce()
})

it('encodes attachment chunks canonically and rejects a changing blob before native import', async () => {
  const media = await import('./media'),
    image = imageFixture(),
    document = fixture(),
    raw = Uint8Array.from({ length: 3 * 8192 + 2 }, (_, index) => index % 251)
  const attachment = `sha256:${createHash('sha256').update(raw).digest('hex')}`
  api.presentationImageImportAttachment.mockResolvedValue(image)
  await media.importPresentationAttachment(attachment, new Blob([raw]), document)
  expect(api.presentationImageImportAttachment).toHaveBeenCalledWith(
    attachment,
    Buffer.from(raw).toString('base64'),
    document,
  )
  const changing = {
    size: 4,
    arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.of(1, 2, 3).buffer),
  } as unknown as Blob
  await expect(media.importPresentationAttachment(attachment, changing, document)).rejects.toThrow(
    'size changed',
  )
  expect(api.presentationImageImportAttachment).toHaveBeenCalledOnce()
})

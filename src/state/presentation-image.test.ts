import { beforeEach, expect, it, vi } from 'vitest'
const media = vi.hoisted(() => ({
  choosePresentationImage: vi.fn(),
  documentImages: vi.fn(),
  importPresentationAttachment: vi.fn(),
}))
vi.mock('@/lib/presentation/media', () => media)
import { createPresentationEditor } from './presentation-editor'
import { fixture } from '@/lib/presentation/fixtures.test-support'
import { imageFixture } from '@/lib/presentation/image.test-support'
import { blankSlide } from '@/lib/presentation/authoring'
beforeEach(() => {
  vi.resetAllMocks()
  media.documentImages.mockResolvedValue({})
})

it('inserts one image as an undoable edit, keeping the original source and saved revision', async () => {
  const store = createPresentationEditor(),
    source = fixture(),
    image = imageFixture(1200, 600)
  store.getState().replace(source)
  store.setState({ revision: 'a'.repeat(64), saved: JSON.stringify(source) })
  media.choosePresentationImage.mockResolvedValue(image)
  const id = await store.getState().insertImage(source.slides[0]!.id)
  expect(id).not.toBeNull()
  expect(store.getState().document?.version).toBe(2)
  expect(store.getState().document?.slides[0]?.elements.at(-1)).toMatchObject({
    id,
    kind: 'image',
    asset: image.id,
    width: 1120,
    height: 560,
  })
  expect(store.getState().revision).toBe('a'.repeat(64))
  expect(store.getState().saved).toBe(JSON.stringify(source))
  store.getState().undo()
  expect(store.getState().document).toEqual(source)
  store.getState().redo()
  expect(store.getState().document?.slides[0]?.elements.at(-1)?.id).toBe(id)
})

it('preserves current document on cancellation, read failure, count limit and busy state', async () => {
  const store = createPresentationEditor(),
    source = fixture()
  store.getState().replace(source)
  media.choosePresentationImage
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(Error('failed'))
    .mockResolvedValue(imageFixture())
  expect(await store.getState().insertImage(source.slides[0]!.id)).toBeNull()
  expect(await store.getState().insertImage(source.slides[0]!.id)).toBeNull()
  expect(store.getState().document).toEqual(source)
  expect(store.getState().error).toContain('failed')
  media.documentImages.mockRejectedValueOnce(Error('resource limit'))
  expect(await store.getState().insertImage(source.slides[0]!.id)).toBeNull()
  expect(store.getState().document).toEqual(source)
  store.setState({ busy: 'update' })
  expect(await store.getState().insertImage(source.slides[0]!.id)).toBeNull()
  store.setState({ busy: null })
  expect(await store.getState().insertImage('missing')).toBeNull()
})

it('locks switching and updates while the file selection is pending', async () => {
  const store = createPresentationEditor(),
    source = fixture()
  store.getState().replace(source)
  let finish!: (value: null) => void
  media.choosePresentationImage.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const operation = store.getState().insertImage(source.slides[0]!.id)
  expect(store.getState().busy).toBe('image')
  expect(store.getState().replace(source, true)).toBe(false)
  expect(store.getState().lockForUpdate()).toBe(false)
  expect(
    store.getState().edit((doc) => {
      doc.title = 'lost'
    }),
  ).toBe(false)
  finish(null)
  await operation
  expect(store.getState().busy).toBeNull()
  expect(store.getState().document).toEqual(source)
})

it('keeps the active slide across panes and inserts an authorized attachment there', async () => {
  const store = createPresentationEditor(),
    source = fixture(),
    image = imageFixture()
  source.slides.push({ ...blankSlide('Second'), id: 'second' })
  store.getState().replace(source)
  expect(store.getState().activeSlide).toBe(source.slides[0]!.id)
  expect(store.getState().selectSlide('second')).toBe(true)
  expect(store.getState().selectSlide('missing')).toBe(false)
  media.importPresentationAttachment.mockResolvedValue(image)
  const blob = new Blob([Uint8Array.from([1, 2, 3])])
  const id = await store.getState().insertImageAttachment(`sha256:${'b'.repeat(64)}`, blob)
  expect(media.importPresentationAttachment).toHaveBeenCalledWith(
    `sha256:${'b'.repeat(64)}`,
    blob,
    source,
  )
  expect(store.getState().document?.slides[0]!.elements).toEqual(source.slides[0]!.elements)
  expect(store.getState().document?.slides[1]!.elements.at(-1)).toMatchObject({
    id,
    kind: 'image',
    asset: image.id,
  })
  expect(store.getState().activeSlide).toBe('second')
  store.getState().undo()
  expect(store.getState().document).toEqual(source)
  expect(store.getState().activeSlide).toBe('second')
})

it('falls back after removing the active slide and preserves the draft on attachment failure', async () => {
  const store = createPresentationEditor(),
    source = fixture()
  source.slides.push({ ...blankSlide('Second'), id: 'second' })
  store.getState().replace(source)
  store.getState().selectSlide('second')
  store.getState().edit((document) => {
    document.slides = document.slides.filter((slide) => slide.id !== 'second')
  })
  expect(store.getState().activeSlide).toBe(source.slides[0]!.id)
  const before = structuredClone(store.getState().document)
  media.importPresentationAttachment.mockRejectedValue(new Error('digest mismatch'))
  expect(
    await store
      .getState()
      .insertImageAttachment(`sha256:${'b'.repeat(64)}`, new Blob([Uint8Array.of(1)])),
  ).toBeNull()
  expect(store.getState().document).toEqual(before)
  expect(store.getState().error).toContain('digest mismatch')
})

it('keeps a later slide selection while one attachment is admitted to its initiating slide', async () => {
  const store = createPresentationEditor(),
    source = fixture(),
    image = imageFixture()
  source.slides.push({ ...blankSlide('Second'), id: 'second' })
  store.getState().replace(source)
  store.getState().selectSlide('second')
  let finish!: (value: typeof image) => void
  media.importPresentationAttachment.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const operation = store
    .getState()
    .insertImageAttachment(`sha256:${'b'.repeat(64)}`, new Blob([Uint8Array.of(1)]))
  expect(store.getState().busy).toBe('image')
  expect(store.getState().selectSlide(source.slides[0]!.id)).toBe(true)
  expect(
    await store
      .getState()
      .insertImageAttachment(`sha256:${'c'.repeat(64)}`, new Blob([Uint8Array.of(2)])),
  ).toBeNull()
  finish(image)
  await operation
  expect(store.getState().activeSlide).toBe(source.slides[0]!.id)
  expect(store.getState().document?.slides[1]!.elements.at(-1)).toMatchObject({
    kind: 'image',
    asset: image.id,
  })
  expect(store.getState().document?.slides[0]!.elements).toEqual(source.slides[0]!.elements)
})

import { beforeEach, expect, it, vi } from 'vitest'
const media = vi.hoisted(() => ({
  choosePresentationImage: vi.fn(),
  importPresentationAttachment: vi.fn(),
}))
vi.mock('@/lib/presentation/media', () => media)
import { createPresentationEditor } from './presentation-editor'
import { fixture } from '@/lib/presentation/fixtures.test-support'
import { imageElement, imageFixture } from '@/lib/presentation/image.test-support'
import { blankSlide } from '@/lib/presentation/authoring'
import { PRESENTATION_LIMIT, type PresentationDocument } from '@/lib/presentation/document'
beforeEach(() => {
  vi.resetAllMocks()
})

function fullSlideDocument(): PresentationDocument {
  const source = fixture()
  const shape = source.slides[0]!.elements.find((element) => element.kind === 'shape')!
  source.slides[0]!.elements = Array.from({ length: 200 }, (_, index) => ({
    ...shape,
    id: `shape-${index}`,
  }))
  return source
}

function fullDocument(): PresentationDocument {
  const source = fixture()
  const shape = source.slides[0]!.elements.find((element) => element.kind === 'shape')!
  source.slides = Array.from({ length: 11 }, (_, slide) => ({
    ...blankSlide(`Slide ${slide + 1}`),
    id: `slide-${slide}`,
    elements: Array.from({ length: slide === 0 ? 199 : slide === 10 ? 1 : 200 }, (_, index) => ({
      ...shape,
      id: `shape-${slide}-${index}`,
    })),
  }))
  return source
}

function nearSizeLimitDocument(remaining = 32): PresentationDocument {
  const source = fixture()
  const template = source.slides[0]!.elements.find((element) => element.kind === 'text')!
  const elements = source.slides[0]!.elements
  elements.length = 0
  while (elements.length < 199) {
    const item = { ...template, id: `text-${elements.length}`, text: 'x'.repeat(20_000) }
    elements.push(item)
    if (new TextEncoder().encode(JSON.stringify(source)).length > PRESENTATION_LIMIT - 20_500) {
      break
    }
  }
  const filler = { ...template, id: `text-${elements.length}`, text: '' }
  elements.push(filler)
  const base = new TextEncoder().encode(JSON.stringify(source)).length
  const padding = PRESENTATION_LIMIT - remaining - base
  expect(padding).toBeGreaterThan(0)
  expect(padding).toBeLessThanOrEqual(20_000)
  filler.text = 'x'.repeat(padding)
  expect(new TextEncoder().encode(JSON.stringify(source))).toHaveLength(
    PRESENTATION_LIMIT - remaining,
  )
  return source
}

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

it('preserves current document on cancellation, read failure and busy state', async () => {
  const store = createPresentationEditor(),
    source = fixture()
  store.getState().replace(source)
  media.choosePresentationImage.mockResolvedValueOnce(null).mockRejectedValueOnce(Error('failed'))
  expect(await store.getState().insertImage(source.slides[0]!.id)).toBeNull()
  expect(await store.getState().insertImage(source.slides[0]!.id)).toBeNull()
  expect(store.getState().document).toEqual(source)
  expect(store.getState().error).toContain('failed')
  store.setState({ busy: 'update' })
  expect(await store.getState().insertImage(source.slides[0]!.id)).toBeNull()
  store.setState({ busy: null })
  expect(await store.getState().insertImage('missing')).toBeNull()
})

it('rejects a full target slide before opening a picker or storing an attachment', async () => {
  const store = createPresentationEditor(),
    source = fullSlideDocument(),
    blob = new Blob([Uint8Array.of(1)])
  store.getState().replace(source)
  expect(await store.getState().insertImage(source.slides[0]!.id)).toBeNull()
  expect(media.choosePresentationImage).not.toHaveBeenCalled()
  expect(await store.getState().insertImageAttachment(`sha256:${'b'.repeat(64)}`, blob)).toBeNull()
  expect(media.importPresentationAttachment).not.toHaveBeenCalled()
  expect(store.getState().document).toEqual(source)
  expect(store.getState().error).toContain('item count')
})

it('rejects global element and byte limits before an attachment can reach native storage', async () => {
  const blob = new Blob([Uint8Array.of(1)])
  for (const [source, reason] of [
    [fullDocument(), 'element count'],
    [nearSizeLimitDocument(), 'document size'],
  ] as const) {
    const store = createPresentationEditor()
    expect(store.getState().replace(source)).toBe(true)
    expect(
      await store.getState().insertImageAttachment(`sha256:${'b'.repeat(64)}`, blob),
    ).toBeNull()
    expect(media.importPresentationAttachment).not.toHaveBeenCalled()
    expect(store.getState().document).toEqual(source)
    expect(store.getState().error).toContain(reason)
    media.importPresentationAttachment.mockClear()
  }
})

it('allows native deduplication when a document already references 100 image resources', async () => {
  const store = createPresentationEditor(),
    source = fixture(),
    reused = imageFixture(),
    blob = new Blob([Uint8Array.of(1)])
  source.version = 2
  source.slides[0]!.elements = Array.from({ length: 100 }, (_, index) => ({
    ...imageElement(reused),
    id: `picture-${index}`,
    asset: index === 0 ? reused.id : index.toString(16).padStart(64, '0'),
  }))
  expect(store.getState().replace(source)).toBe(true)
  media.importPresentationAttachment.mockResolvedValue(reused)
  expect(
    await store.getState().insertImageAttachment(`sha256:${'b'.repeat(64)}`, blob),
  ).not.toBeNull()
  expect(media.importPresentationAttachment).toHaveBeenCalledOnce()
  expect(store.getState().document?.slides[0]!.elements).toHaveLength(101)
})

it('commits extreme image geometry when a near-limit document passes conservative preflight', async () => {
  const store = createPresentationEditor(),
    source = nearSizeLimitDocument(512),
    extreme = { ...imageFixture(), width: 8192, height: 8191 }
  expect(store.getState().replace(source)).toBe(true)
  media.importPresentationAttachment.mockResolvedValue(extreme)
  expect(
    await store
      .getState()
      .insertImageAttachment(`sha256:${'b'.repeat(64)}`, new Blob([Uint8Array.of(1)])),
  ).not.toBeNull()
  const document = store.getState().document!
  expect(new TextEncoder().encode(JSON.stringify(document)).length).toBeLessThanOrEqual(
    PRESENTATION_LIMIT,
  )
  expect(document.slides[0]!.elements.at(-1)).toMatchObject({
    kind: 'image',
    asset: extreme.id,
  })
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
  media.importPresentationAttachment.mockRejectedValue(
    new Error('animated images are not supported; choose a static image'),
  )
  expect(
    await store
      .getState()
      .insertImageAttachment(`sha256:${'c'.repeat(64)}`, new Blob([Uint8Array.of(2)])),
  ).toBeNull()
  expect(store.getState().error).toBe('animated images are not supported; choose a static image')
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

import { create } from 'zustand'
import { parsePresentation, type PresentationDocument } from '@/lib/presentation/document'
import { copyPresentation, retainHistory } from '@/lib/presentation/authoring'
import { loadPresentation, savePresentation } from '@/lib/presentation/repository'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import {
  choosePresentationImage,
  documentImages,
  importPresentationAttachment,
} from '@/lib/presentation/media'
import { presentationSize } from '@/lib/presentation/document'
import type { PresentationImage } from '@/lib/ipc'

interface PendingInput {
  value: string
  label: string
  commit: (value: string) => boolean
}

interface EditorState {
  document: PresentationDocument | null
  activeSlide: string | null
  revision: string | null
  saved: string | null
  past: string[]
  future: string[]
  busy: 'load' | 'save' | 'copy' | 'image' | 'update' | 'synchronizing' | null
  lockForUpdate: () => boolean
  unlockUpdate: () => void
  error: string | null
  inputs: Record<string, PendingInput>
  stageInput: (key: string, input: PendingInput) => void
  discardInput: (key: string) => void
  commitInput: (key: string) => boolean
  flushInputs: () => boolean
  selectSlide: (id: string) => boolean
  replace: (source: unknown, discard?: boolean) => boolean
  edit: (change: (draft: PresentationDocument) => void) => boolean
  undo: () => void
  redo: () => void
  open: (id: string, discard?: boolean) => Promise<boolean>
  save: () => Promise<boolean>
  saveCopy: (suffix: string) => Promise<boolean>
  insertImage: (slide: string) => Promise<string | null>
  insertImageAttachment: (attachmentId: string, blob: Blob) => Promise<string | null>
}

export const isPresentationDirty = (
  state: Pick<EditorState, 'document' | 'saved' | 'inputs'>,
): boolean =>
  Object.keys(state.inputs).length > 0 ||
  (state.document !== null && JSON.stringify(state.document) !== state.saved)

async function appendImage(
  source: PresentationDocument,
  slideId: string,
  image: PresentationImage,
) {
  const document = parsePresentation(source)
  const slide = document.slides.find((page) => page.id === slideId)
  if (!slide) throw new Error('The selected slide no longer exists')
  const size = presentationSize(document.aspect)
  const scale = Math.min((size.width - 160) / image.width, (size.height - 160) / image.height, 1)
  const width = Math.max(1, image.width * scale),
    height = Math.max(1, image.height * scale),
    id = crypto.randomUUID()
  document.version = 2
  slide.elements.push({
    id,
    kind: 'image',
    asset: image.id,
    alt: '',
    fit: 'contain',
    x: (size.width - width) / 2,
    y: (size.height - height) / 2,
    width,
    height,
    rotation: 0,
  })
  const checked = parsePresentation(document)
  await documentImages(checked)
  return { document: checked, id }
}

/** One editor owns its draft; switching panes does not discard pending changes. */
export function createPresentationEditor(synchronizing = false) {
  let committingInput = false
  return create<EditorState>((set, get) => ({
    document: null,
    activeSlide: null,
    revision: null,
    saved: null,
    past: [],
    future: [],
    busy: synchronizing ? 'synchronizing' : null,
    error: null,
    inputs: {},
    stageInput: (key, input) => {
      if (!get().document || (get().busy !== null && get().busy !== 'save')) return
      set({ inputs: { ...get().inputs, [key]: input } })
    },
    discardInput: (key) => {
      if (get().busy !== null && get().busy !== 'save') return
      const inputs = { ...get().inputs }
      delete inputs[key]
      set({ inputs, error: null })
    },
    commitInput: (key) => {
      const input = get().inputs[key]
      if (!input) return true
      if (get().busy !== null && get().busy !== 'save') return false
      committingInput = true
      try {
        if (!input.commit(input.value)) {
          set({ error: get().error ?? t('deck.invalidInput') })
          return false
        }
        get().discardInput(key)
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      } finally {
        committingInput = false
      }
    },
    flushInputs: () => {
      for (const key of Object.keys(get().inputs)) {
        if (!get().commitInput(key)) return false
      }
      return true
    },
    selectSlide: (id) => {
      if (!get().document?.slides.some((slide) => slide.id === id)) return false
      set({ activeSlide: id })
      return true
    },
    lockForUpdate: () => {
      const state = get()
      if (state.busy || isPresentationDirty(state)) return false
      set({ busy: 'update' })
      return true
    },
    unlockUpdate: () => {
      if (get().busy === 'update') set({ busy: null })
    },
    replace: (source, discard = false) => {
      if (get().busy || (!discard && isPresentationDirty(get()))) return false
      try {
        const document = parsePresentation(source)
        set({
          document,
          activeSlide: document.slides[0]!.id,
          revision: null,
          saved: null,
          past: [],
          future: [],
          error: null,
          inputs: {},
        })
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      }
    },
    edit: (change) => {
      const state = get()
      if (!state.document || (state.busy !== null && state.busy !== 'save')) return false
      if (!committingInput && Object.keys(state.inputs).length > 0) {
        set({ error: t('deck.invalidInput') })
        return false
      }
      try {
        const before = JSON.stringify(state.document)
        const draft = parsePresentation(state.document)
        change(draft)
        const document = parsePresentation(draft)
        if (document.id !== state.document.id) throw new Error('Document identity cannot be edited')
        if (JSON.stringify(document) === before) return true
        set({
          document,
          activeSlide: document.slides.some((slide) => slide.id === state.activeSlide)
            ? state.activeSlide
            : document.slides[0]!.id,
          past: retainHistory(state.past, before),
          future: [],
          error: null,
        })
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      }
    },
    undo: () => {
      if (!get().flushInputs()) return
      const state = get()
      if (!state.document || (state.busy !== null && state.busy !== 'save') || !state.past.length)
        return
      const document = parsePresentation(JSON.parse(state.past.at(-1)!))
      set({
        document,
        activeSlide: document.slides.some((slide) => slide.id === state.activeSlide)
          ? state.activeSlide
          : document.slides[0]!.id,
        past: state.past.slice(0, -1),
        future: retainHistory(state.future, JSON.stringify(state.document)),
        error: null,
      })
    },
    redo: () => {
      if (!get().flushInputs()) return
      const state = get()
      if (!state.document || (state.busy !== null && state.busy !== 'save') || !state.future.length)
        return
      const document = parsePresentation(JSON.parse(state.future.at(-1)!))
      set({
        document,
        activeSlide: document.slides.some((slide) => slide.id === state.activeSlide)
          ? state.activeSlide
          : document.slides[0]!.id,
        future: state.future.slice(0, -1),
        past: retainHistory(state.past, JSON.stringify(state.document)),
        error: null,
      })
    },
    open: async (id, discard = false) => {
      if (get().busy || (!discard && isPresentationDirty(get()))) return false
      set({ busy: 'load', error: null })
      try {
        const saved = await loadPresentation(id)
        if (!saved) throw new Error('The presentation no longer exists')
        set({
          document: saved.document,
          activeSlide: saved.document.slides[0]!.id,
          revision: saved.revision,
          saved: JSON.stringify(saved.document),
          past: [],
          future: [],
          inputs: {},
        })
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      } finally {
        set({ busy: null })
      }
    },
    saveCopy: async (suffix) => {
      if (!get().flushInputs()) return false
      const state = get()
      if (state.busy || !state.document) return false
      set({ busy: 'copy', error: null })
      try {
        const saved = await savePresentation(copyPresentation(state.document, suffix), null)
        set({
          document: saved.document,
          activeSlide: saved.document.slides[0]!.id,
          revision: saved.revision,
          saved: JSON.stringify(saved.document),
          past: [],
          future: [],
          inputs: {},
        })
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      } finally {
        set({ busy: null })
      }
    },
    insertImage: async (slideId) => {
      if (!get().flushInputs()) return null
      const state = get()
      if (
        state.busy ||
        !state.document ||
        !state.document.slides.some((slide) => slide.id === slideId)
      )
        return null
      set({ busy: 'image', error: null })
      try {
        const image = await choosePresentationImage(state.document)
        if (!image) return null
        const placed = await appendImage(state.document, slideId, image)
        set((current) => ({
          document: placed.document,
          activeSlide: placed.document.slides.some((slide) => slide.id === current.activeSlide)
            ? current.activeSlide
            : slideId,
          past: retainHistory(state.past, JSON.stringify(state.document)),
          future: [],
        }))
        return placed.id
      } catch (cause) {
        set({ error: describe(cause) })
        return null
      } finally {
        set({ busy: null })
      }
    },
    insertImageAttachment: async (attachmentId, blob) => {
      if (!get().flushInputs()) return null
      const state = get()
      const slideId = state.activeSlide ?? state.document?.slides[0]?.id ?? null
      if (state.busy || !state.document || !slideId) return null
      set({ busy: 'image', error: null })
      try {
        const image = await importPresentationAttachment(attachmentId, blob, state.document)
        const placed = await appendImage(state.document, slideId, image)
        set((current) => ({
          document: placed.document,
          activeSlide: placed.document.slides.some((slide) => slide.id === current.activeSlide)
            ? current.activeSlide
            : slideId,
          past: retainHistory(state.past, JSON.stringify(state.document)),
          future: [],
        }))
        return placed.id
      } catch (cause) {
        set({ error: describe(cause) })
        return null
      } finally {
        set({ busy: null })
      }
    },
    save: async () => {
      if (!get().flushInputs()) return false
      const state = get()
      if (state.busy || !state.document) return false
      const snapshot = parsePresentation(state.document)
      set({ busy: 'save', error: null })
      try {
        const saved = await savePresentation(snapshot, state.revision)
        // Edits made while disk I/O runs remain dirty. Never replace the live draft.
        set({ revision: saved.revision, saved: JSON.stringify(saved.document) })
        return true
      } catch (cause) {
        set({ error: describe(cause) })
        return false
      } finally {
        set({ busy: null })
      }
    },
  }))
}

export const usePresentationEditor = createPresentationEditor(true)

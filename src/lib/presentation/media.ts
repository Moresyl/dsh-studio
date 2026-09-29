import { open } from '@tauri-apps/plugin-dialog'
import {
  presentationImageImport,
  presentationImageImportAttachment,
  presentationImageRead,
  type PresentationImage,
} from '@/lib/ipc'
import { t } from '@/lib/i18n'
import { PresentationError, type PresentationDocument } from './document'
import { validateImage } from './image'

const cache = new Map<string, PresentationImage>()
let cachedBytes = 0
const pending = new Map<string, Promise<PresentationImage>>()

function bounded<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      cleanup()
      reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new PresentationError('image', 'image read timed out'))
    }, 30_000)
    signal?.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (cause) => {
        cleanup()
        reject(cause)
      },
    )
    if (signal?.aborted) abort()
  })
}

function remember(image: PresentationImage): PresentationImage {
  cachedBytes -= cache.get(image.id)?.bytes ?? 0
  cache.delete(image.id)
  cache.set(image.id, image)
  cachedBytes += image.bytes
  while (cachedBytes > 32 * 1024 * 1024 || cache.size > 100) {
    const oldest = cache.values().next().value!
    cache.delete(oldest.id)
    cachedBytes -= oldest.bytes
  }
  return image
}

export async function readImage(id: string, fresh = false): Promise<PresentationImage> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new PresentationError('image', 'invalid resource identity')
  const cached = cache.get(id)
  if (!fresh && cached) return remember(cached)
  const existing = pending.get(id)
  if (existing) return existing
  const operation = bounded(presentationImageRead(id))
    .then((value) => remember(validateImage(value, id)))
    .finally(() => pending.delete(id))
  pending.set(id, operation)
  return operation
}

/** Read only referenced resources, once each; no URL from a document is fetched. */
export async function documentImages(document: PresentationDocument, signal?: AbortSignal) {
  const result: Record<string, PresentationImage> = {}
  let total = 0
  for (const page of document.slides) {
    for (const element of page.elements) {
      signal?.throwIfAborted()
      if (element.kind !== 'image' || result[element.asset]) continue
      const image = await bounded(readImage(element.asset, true), signal)
      signal?.throwIfAborted()
      total += image.bytes
      if (total > 16 * 1024 * 1024)
        throw new PresentationError('image', 'document images exceed 16 MiB')
      result[element.asset] = image
    }
  }
  return result
}

/** Selecting a file does not alter the document; the editor promotes it after validation. */
export async function choosePresentationImage(
  document: PresentationDocument,
): Promise<PresentationImage | null> {
  const path = await open({
    multiple: false,
    directory: false,
    title: t('deck.image'),
    filters: [{ name: t('deck.image'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  })
  if (path === null) return null
  if (typeof path !== 'string') throw new PresentationError('image', 'choose one image')
  return remember(validateImage(await bounded(presentationImageImport(path, document))))
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [],
    size = 3 * 8192
  for (let offset = 0; offset < bytes.length; offset += size)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + size))))
  return chunks.join('')
}

/** Admit one already session-authorized attachment without exposing a host path. */
export async function importPresentationAttachment(
  attachmentId: string,
  blob: Blob,
  document: PresentationDocument,
): Promise<PresentationImage> {
  if (!/^sha256:[a-f0-9]{64}$/.test(attachmentId))
    throw new PresentationError('image', 'invalid attachment identity')
  if (blob.size < 1 || blob.size > 16 * 1024 * 1024)
    throw new PresentationError('image', 'attachment image exceeds 16 MiB')
  const bytes = new Uint8Array(await bounded(blob.arrayBuffer()))
  if (bytes.byteLength !== blob.size)
    throw new PresentationError('image', 'attachment image size changed while reading')
  return remember(
    validateImage(
      await bounded(presentationImageImportAttachment(attachmentId, base64(bytes), document)),
    ),
  )
}

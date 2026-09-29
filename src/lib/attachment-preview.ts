/** Attachment reads stay on authenticated Harness APIs, never host paths. */
export const IMAGE_LIMIT = 20 * 1024 * 1024
const TIMEOUT = 20_000
const REQUEST = 'dsh-studio:image-read'
const RESPONSE = 'dsh-studio:image-result'

interface ImageReply {
  attachment: {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
  }
  data: string
}

export function imageBlob(value: unknown, expected: string): Blob {
  const reply = value as ImageReply | null
  const ref = reply?.attachment
  if (
    !ref ||
    ref.attachmentId !== expected ||
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType) ||
    !Number.isSafeInteger(ref.bytes) ||
    ref.bytes < 1 ||
    ref.bytes > IMAGE_LIMIT ||
    !Number.isSafeInteger(ref.width) ||
    !Number.isSafeInteger(ref.height) ||
    ref.width < 1 ||
    ref.height < 1 ||
    ref.width > 8192 ||
    ref.height > 8192 ||
    ref.width * ref.height > 64_000_000 ||
    typeof reply?.data !== 'string' ||
    reply.data.length > Math.ceil(IMAGE_LIMIT / 3) * 4
  ) {
    throw new Error('Invalid or oversized image preview')
  }
  let bytes: Uint8Array<ArrayBuffer>
  try {
    const raw = atob(reply.data)
    if (btoa(raw) !== reply.data || raw.length !== ref.bytes) throw new Error('size')
    bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0))
  } catch {
    throw new Error('Invalid image preview encoding')
  }
  return new Blob([bytes], { type: ref.mediaType })
}

export function textBlob(value: unknown, expected: string): Blob {
  const reply = value as { attachmentId?: unknown; bytes?: number; text?: unknown } | null
  if (
    !reply ||
    reply.attachmentId !== expected ||
    !Number.isSafeInteger(reply.bytes) ||
    reply.bytes! < 0 ||
    reply.bytes! > 1024 * 1024 ||
    typeof reply.text !== 'string' ||
    reply.text.length > 1024 * 1024 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reply.text)
  ) {
    throw new Error('Invalid text preview')
  }
  const blob = new Blob([reply.text], { type: 'text/plain;charset=utf-8' })
  if (blob.size !== reply.bytes) throw new Error('Invalid text preview size')
  return blob
}

type ReadImage = (
  sessionId: string,
  attachmentId: string,
  signal: AbortSignal,
  kind?: 'image' | 'file',
) => Promise<Blob>
let reader: ReadImage | null = null

export function previewImage(
  sessionId: string,
  attachmentId: string,
  signal: AbortSignal,
): Promise<Blob> {
  if (!reader) return Promise.reject(new Error('Start Harness before previewing an image'))
  return reader(sessionId, attachmentId, signal)
}

export function previewText(
  sessionId: string,
  attachmentId: string,
  signal: AbortSignal,
): Promise<Blob> {
  if (!reader) return Promise.reject(new Error('Start Harness before previewing a file'))
  return reader(sessionId, attachmentId, signal, 'file')
}

/** Bound to one exact iframe generation; teardown rejects all outstanding reads. */
export function serveImagePreview(peer: Window, origin: string): () => void {
  const pending = new Map<string, (data?: unknown, error?: Error) => void>()
  const read: ReadImage = (sessionId, attachmentId, signal, kind = 'image') =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Image preview cancelled'))
        return
      }
      if (!sessionId || sessionId.length > 512 || !/^sha256:[a-f0-9]{64}$/.test(attachmentId)) {
        reject(new Error('Invalid attachment identity'))
        return
      }
      if (pending.size >= 4) {
        reject(new Error('Too many image preview requests'))
        return
      }
      const id = crypto.randomUUID()
      const abort = () => finish(undefined, new Error('Image preview cancelled'))
      const timer = setTimeout(
        () => finish(undefined, new Error('Image preview timed out')),
        TIMEOUT,
      )
      const finish = (data?: unknown, error?: Error) => {
        if (!pending.delete(id)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (error && kind === 'file') {
          try {
            peer.postMessage({ type: 'dsh-studio:preview-cancel', id }, origin)
          } catch {
            /* Frame already closed. */
          }
        }
        if (error) reject(error)
        else {
          try {
            resolve(kind === 'file' ? textBlob(data, attachmentId) : imageBlob(data, attachmentId))
          } catch (cause) {
            reject(cause)
          }
        }
      }
      pending.set(id, finish)
      signal.addEventListener('abort', abort, { once: true })
      try {
        peer.postMessage({ type: REQUEST, id, sessionId, attachmentId, kind }, origin)
      } catch {
        finish(undefined, new Error('Image preview connection is unavailable'))
      }
    })
  const receive = (event: MessageEvent) => {
    if (event.source !== peer || event.origin !== origin || event.data?.type !== RESPONSE) return
    const finish = pending.get(event.data.id)
    if (!finish) return
    if (event.data.ok === true) finish(event.data.value)
    else finish(undefined, new Error('Harness could not authorize or read this image'))
  }
  reader = read
  window.addEventListener('message', receive)
  return () => {
    if (reader === read) reader = null
    window.removeEventListener('message', receive)
    for (const finish of pending.values()) finish(undefined, new Error('Harness connection ended'))
  }
}

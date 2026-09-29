/** Session-authorized, verified UTF-8 previews; no host paths cross this route. */
import { createHash } from 'node:crypto'

export const FILE_PREVIEW_BYTES = 1024 * 1024
export const FILE_PREVIEW_ROUTE = '/api/studio/file-preview'
export const FILE_DOWNLOAD_BYTES = 20 * 1024 * 1024
export const FILE_DOWNLOAD_ROUTE = '/api/studio/file-download'

function fault(code, status) {
  return Object.assign(new Error(code), { code, status })
}

/** Only durable file blocks in known message event types grant access. */
function referencedFile(events, id) {
  for (const event of events) {
    const message =
      event.type === 'user/message'
        ? event.data
        : ['assistant/message', 'tool/result'].includes(event.type)
          ? event.data?.message
          : null
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content) {
      if (block.type === 'file' && block.attachment?.attachmentId === id) return block.attachment
    }
  }
}

/** Verify the entire bounded object before returning any content to the browser. */
async function readVerifiedFile(ctx, sessionId, attachmentId, signal, maximum) {
  if (
    typeof sessionId !== 'string' ||
    !sessionId ||
    sessionId.length > 512 ||
    typeof attachmentId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(attachmentId)
  ) {
    throw fault('INVALID_IDENTITY', 400)
  }
  signal.throwIfAborted()
  const snapshot = await ctx.sessionQuery.observeSession(sessionId, {
    signal,
    projectionMode: 'none',
  })
  let ref
  try {
    signal.throwIfAborted()
    ref = referencedFile(snapshot.events, attachmentId)
  } finally {
    snapshot[Symbol.dispose]()
  }
  if (!ref) throw fault('ATTACHMENT_NOT_REFERENCED', 404)
  if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw fault('INVALID_ATTACHMENT', 422)
  if (ref.bytes > maximum) throw fault('FILE_TOO_LARGE', 413)
  const data = Buffer.alloc(ref.bytes)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of ctx.attachments.readFileStream(ref, signal)) {
    signal.throwIfAborted()
    if (!(chunk instanceof Uint8Array)) throw fault('INVALID_ATTACHMENT', 422)
    const end = bytes + chunk.byteLength
    if (end > ref.bytes || end > maximum) throw fault('INVALID_ATTACHMENT', 422)
    data.set(chunk, bytes)
    hash.update(data.subarray(bytes, end))
    bytes = end
  }
  signal.throwIfAborted()
  if (bytes !== ref.bytes || `sha256:${hash.digest('hex')}` !== attachmentId) {
    throw fault('INVALID_ATTACHMENT', 422)
  }
  return data
}

export async function readFileDownload(ctx, sessionId, attachmentId, signal) {
  const data = await readVerifiedFile(ctx, sessionId, attachmentId, signal, FILE_DOWNLOAD_BYTES)
  return { attachmentId, bytes: data.length, data: data.toString('base64') }
}

export async function readFilePreview(ctx, sessionId, attachmentId, signal) {
  const data = await readVerifiedFile(ctx, sessionId, attachmentId, signal, FILE_PREVIEW_BYTES)
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
  } catch {
    throw fault('UNSUPPORTED_ENCODING', 415)
  }
  // These controls identify binary data, and are not useful in a literal text view.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw fault('UNSUPPORTED_ENCODING', 415)
  }
  return { attachmentId, bytes: data.length, text }
}

/** Connection owns authentication, Host/Origin checks, and route disposal. */
export function registerFilePreview(ctx) {
  const lifetime = new AbortController()
  let active = 0
  ctx.effect(() => () => lifetime.abort(), 'dsh-studio: file preview lifetime')
  for (const [path, read] of [
    [FILE_PREVIEW_ROUTE, readFilePreview],
    [FILE_DOWNLOAD_ROUTE, readFileDownload],
  ]) {
    ctx.connection.fetch.register({
      path,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
        const respond = (value, status) => Response.json(value, { status, headers })
        if (lifetime.signal.aborted) return respond({ error: 'UNAVAILABLE' }, 503)
        if (active >= 4) return respond({ error: 'BUSY' }, 429)
        active += 1
        const timeout = new AbortController()
        const timer = setTimeout(() => timeout.abort(), 20_000)
        const signal = AbortSignal.any([request.signal, lifetime.signal, timeout.signal])
        try {
          const query = new URL(request.url).searchParams
          if (
            [...query.keys()].some((key) => !['sessionId', 'attachmentId'].includes(key)) ||
            query.getAll('sessionId').length !== 1 ||
            query.getAll('attachmentId').length !== 1
          ) {
            throw fault('INVALID_IDENTITY', 400)
          }
          return respond(
            await read(ctx, query.get('sessionId'), query.get('attachmentId'), signal),
            200,
          )
        } catch (error) {
          const known = [
            'INVALID_IDENTITY',
            'ATTACHMENT_NOT_REFERENCED',
            'INVALID_ATTACHMENT',
            'FILE_TOO_LARGE',
            'UNSUPPORTED_ENCODING',
          ].includes(error?.code)
          return respond({ error: known ? error.code : 'UNAVAILABLE' }, known ? error.status : 503)
        } finally {
          clearTimeout(timer)
          active -= 1
        }
      },
    })
  }
}

import { parsePresentation, PresentationError } from './document'
import type { PresentationImage } from '@/lib/ipc'

/** Keep document generation off the UI thread, with a worker owned by this operation. */
export async function exportPresentationBackground(
  source: unknown,
  signal: AbortSignal,
  images: Record<string, PresentationImage> = {},
): Promise<Uint8Array> {
  signal.throwIfAborted()
  const document = parsePresentation(source)
  let worker: Worker
  try {
    worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    throw new PresentationError('export', 'could not start background export')
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: Uint8Array | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const abort = () => finish(new DOMException('Presentation export cancelled', 'AbortError'))
    const timer = setTimeout(
      () => finish(new PresentationError('export', 'background export timed out')),
      30_000,
    )
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data
      if (
        value &&
        typeof value === 'object' &&
        'bytes' in value &&
        value.bytes instanceof ArrayBuffer &&
        value.bytes.byteLength > 0 &&
        value.bytes.byteLength <= 20 * 1024 * 1024
      ) {
        finish(new Uint8Array(value.bytes))
      } else finish(new PresentationError('export', 'could not create the presentation'))
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(new PresentationError('export', 'background export failed'))
    }
    worker.onmessageerror = () =>
      finish(new PresentationError('export', 'could not read background export'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) return abort()
    try {
      worker.postMessage({ document, images })
    } catch {
      finish(new PresentationError('export', 'could not start background export'))
    }
  })
}

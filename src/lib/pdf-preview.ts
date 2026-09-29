import {
  getDocument,
  PDFWorker,
  type PDFDocumentProxy,
  type PDFDocumentLoadingTask,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

export interface PdfSession {
  document: PDFDocumentProxy
  close: () => void
}

export function pdfGeometry(
  width: number,
  height: number,
  available: number,
  zoom: number,
  ratio: number,
) {
  if (![width, height, available, zoom, ratio].every(Number.isFinite) || width <= 0 || height <= 0)
    throw new Error('Invalid PDF page dimensions')
  const dpr = Math.max(1, Math.min(2, ratio))
  const scale = Math.min(
    (Math.max(100, available) / width) * Math.max(0.5, Math.min(2, zoom)),
    4096 / width,
    4096 / height,
    Math.sqrt(8_000_000) / Math.sqrt(width) / Math.sqrt(height) / dpr,
  )
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid PDF page scale')
  return {
    scale,
    dpr,
    width: Math.max(1, Math.floor(width * scale * dpr)),
    height: Math.max(1, Math.floor(height * scale * dpr)),
  }
}

/** Each viewer owns a real worker. Closing or timing out terminates parsing too. */
export async function openPdf(
  blob: Blob,
  signal: AbortSignal,
  password?: string,
): Promise<PdfSession> {
  signal.throwIfAborted()
  if (blob.size > 20 * 1024 * 1024) throw new Error('PDF exceeds the preview limit')
  const data = new Uint8Array(await blob.arrayBuffer())
  signal.throwIfAborted()
  if (!new TextDecoder('latin1').decode(data.subarray(0, 1024)).includes('%PDF-'))
    throw new Error('Invalid PDF header')
  const port = new Worker(workerUrl, { type: 'module' })
  let worker: PDFWorker | undefined
  let task: PDFDocumentLoadingTask | undefined
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    port.terminate()
    worker?.destroy()
    void task?.destroy().catch(() => {})
  }
  let abort = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    worker = PDFWorker.create({ port })
    task = getDocument({
      data,
      worker,
      password,
      enableXfa: false,
      stopAtErrors: true,
      maxImageSize: 16_000_000,
      canvasMaxAreaInBytes: 32_000_000,
      cMapUrl: new URL('/pdfjs/cmaps/', location.href).href,
      standardFontDataUrl: new URL('/pdfjs/standard_fonts/', location.href).href,
      wasmUrl: new URL('/pdfjs/wasm/', location.href).href,
      iccUrl: new URL('/pdfjs/iccs/', location.href).href,
    })
    const document = await Promise.race([
      task.promise,
      new Promise<never>((_, reject) => {
        abort = () => {
          close()
          reject(new Error('PDF preview cancelled'))
        }
        signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => {
          close()
          reject(new Error('PDF loading timed out'))
        }, 20_000)
      }),
    ])
    signal.throwIfAborted()
    return { document, close }
  } catch (error) {
    close()
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

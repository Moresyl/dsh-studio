import { exportPresentation } from './export'
import type { PresentationImage } from '@/lib/ipc'

// Each export owns a worker; termination also stops synchronous compression.
self.onmessage = async (
  event: MessageEvent<{ document: unknown; images: Record<string, PresentationImage> }>,
) => {
  try {
    const bytes = await exportPresentation(event.data.document, event.data.images)
    const buffer = new Uint8Array(bytes).buffer
    self.postMessage({ bytes: buffer }, { transfer: [buffer] })
  } catch {
    self.postMessage({ failed: true })
  }
}

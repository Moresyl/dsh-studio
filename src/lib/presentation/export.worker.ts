import { exportPresentation } from './export'

// Each export owns a worker; termination also stops synchronous compression.
self.onmessage = async (event: MessageEvent<unknown>) => {
  try {
    const bytes = await exportPresentation(event.data)
    const buffer = new Uint8Array(bytes).buffer
    self.postMessage({ bytes: buffer }, { transfer: [buffer] })
  } catch {
    self.postMessage({ failed: true })
  }
}

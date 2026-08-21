import { frontendCrash } from '@/lib/ipc'

const MAX_REPORTS_PER_WINDOW = 8
const FIELD_CEILING = 32 << 10

export interface CrashPayload {
  message: string
  stack: string
  url: string
}

type CrashTarget = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  location: Pick<Location, 'href'>
}

type Reporter = (payload: CrashPayload) => Promise<void>

/** Turn a thrown browser value into bounded text without evaluating it. */
export function crashPayload(reason: unknown, url: string): CrashPayload {
  const error = reason instanceof Error ? reason : null
  return {
    message: (error?.message ?? String(reason)).slice(0, FIELD_CEILING),
    stack: (error?.stack ?? '').slice(0, FIELD_CEILING),
    url: url.slice(0, 2_048),
  }
}

/** Capture uncaught renderer failures locally before the first React render. */
export function installCrashEvidence(
  target: CrashTarget = window,
  report: Reporter = async (payload) => await frontendCrash(payload),
): () => void {
  const seen = new Set<string>()
  const record = (reason: unknown, url: string) => {
    const payload = crashPayload(reason, url || target.location.href)
    const signature = `${payload.message}\n${payload.stack}\n${payload.url}`
    if (seen.has(signature) || seen.size >= MAX_REPORTS_PER_WINDOW) return
    seen.add(signature)
    void report(payload).catch(() => {
      // Evidence must never turn one application error into an error loop.
    })
  }
  const onError = (event: ErrorEvent) => record(event.error ?? event.message, event.filename)
  const onRejection = (event: PromiseRejectionEvent) => record(event.reason, target.location.href)
  target.addEventListener('error', onError as EventListener)
  target.addEventListener('unhandledrejection', onRejection as EventListener)
  return () => {
    target.removeEventListener('error', onError as EventListener)
    target.removeEventListener('unhandledrejection', onRejection as EventListener)
  }
}

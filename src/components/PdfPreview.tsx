import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Minus, Plus, RefreshCw } from 'lucide-react'
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { Button } from '@/components/Button'
import { openPdf, pdfGeometry, type PdfSession } from '@/lib/pdf-preview'
import { t } from '@/lib/i18n'

export default function PdfPreview({ blob }: { blob: Blob }) {
  const [attempt, setAttempt] = useState({ password: '', revision: 0 })
  const [password, setPassword] = useState('')
  const [session, setSession] = useState<PdfSession | null>(null)
  const [error, setError] = useState<'password' | 'failed' | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(true)
  const canvasHost = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)

  useEffect(() => {
    const controller = new AbortController()
    let owned: PdfSession | null = null
    void openPdf(blob, controller.signal, attempt.password || undefined)
      .then((opened) => {
        if (controller.signal.aborted) {
          opened.close()
          return
        }
        owned = opened
        setSession(opened)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error && cause.name === 'PasswordException' ? 'password' : 'failed',
          )
      })
    return () => {
      controller.abort()
      owned?.close()
    }
  }, [blob, attempt])

  useEffect(() => {
    const element = canvasHost.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      // The content box excludes both padding and the vertical scrollbar.
      if (entry) setWidth(Math.max(100, Math.floor(entry.contentRect.width)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [error])

  useEffect(() => {
    if (!session || !canvasHost.current) return
    let active = true
    let rendering: RenderTask | undefined
    let current: PDFPageProxy | undefined
    const canvas = document.createElement('canvas')
    canvas.setAttribute('role', 'img')
    canvas.setAttribute(
      'aria-label',
      t('sessions.pdfPage', { page, total: session.document.numPages }),
    )
    canvas.className = 'mx-auto bg-white shadow-sm'
    canvasHost.current.replaceChildren(canvas)
    const timer = setTimeout(() => {
      if (!active) return
      active = false
      rendering?.cancel()
      session.close()
      setError('failed')
    }, 20_000)
    void (async () => {
      current = await session.document.getPage(page)
      if (!active) return
      const natural = current.getViewport({ scale: 1 })
      const geometry = pdfGeometry(
        natural.width,
        natural.height,
        width,
        zoom,
        window.devicePixelRatio || 1,
      )
      const viewport = current.getViewport({ scale: geometry.scale })
      canvas.width = geometry.width
      canvas.height = geometry.height
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      rendering = current.render({
        canvas,
        viewport,
        transform: [geometry.dpr, 0, 0, geometry.dpr, 0, 0],
      })
      await rendering.promise
      const content = await current.getTextContent()
      if (!active) return
      setText(
        content.items
          .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
          .join('')
          .slice(0, 200_000),
      )
      setBusy(false)
      clearTimeout(timer)
    })()
      .catch(() => {
        if (active) {
          clearTimeout(timer)
          session.close()
          setError('failed')
        }
      })
      .finally(() => current?.cleanup())
    return () => {
      active = false
      clearTimeout(timer)
      rendering?.cancel()
      canvas.remove()
    }
  }, [session, page, zoom, width])

  const retry = (value = '') => {
    setError(null)
    setSession(null)
    setBusy(true)
    setPage(1)
    setText('')
    setPassword('')
    setAttempt(({ revision }) => ({ password: value, revision: revision + 1 }))
  }
  const move = (next: number) => {
    setBusy(true)
    setText('')
    setPage(next)
  }
  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {error ? (
        <div role="status" className="space-y-3 p-4 text-center text-[13px] text-muted">
          <p>{t(error === 'password' ? 'sessions.pdfPassword' : 'sessions.pdfFailed')}</p>
          {error === 'password' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                retry(password)
              }}
              className="flex flex-wrap justify-center gap-2"
            >
              <input
                type="password"
                autoComplete="off"
                aria-label={t('sessions.pdfPasswordLabel')}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="field-control"
              />
              <Button type="submit" disabled={!password}>
                {t('sessions.pdfUnlock')}
              </Button>
            </form>
          ) : (
            <Button variant="secondary" onClick={() => retry()}>
              <RefreshCw size={14} />
              {t('sessions.previewRetry')}
            </Button>
          )}
        </div>
      ) : (
        <>
          {session && (
            <div className="flex flex-wrap items-center justify-center gap-3 text-[12px]">
              <Button
                variant="secondary"
                aria-label={t('sessions.pdfPrevious')}
                disabled={page <= 1}
                onClick={() => move(page - 1)}
              >
                <ChevronLeft size={16} />
              </Button>
              <span role="status">
                {t('sessions.pdfPage', { page, total: session.document.numPages })}
              </span>
              <Button
                variant="secondary"
                aria-label={t('sessions.pdfNext')}
                disabled={page >= session.document.numPages}
                onClick={() => move(page + 1)}
              >
                <ChevronRight size={16} />
              </Button>
              <Button
                variant="secondary"
                aria-label={t('sessions.pdfZoomOut')}
                disabled={zoom <= 0.5}
                onClick={() => {
                  setBusy(true)
                  setZoom(zoom - 0.25)
                }}
              >
                <Minus size={14} />
              </Button>
              <Button
                variant="secondary"
                disabled={zoom === 1}
                onClick={() => {
                  setBusy(true)
                  setZoom(1)
                }}
              >
                {t('sessions.pdfFit')} · {Math.round(zoom * 100)}%
              </Button>
              <Button
                variant="secondary"
                aria-label={t('sessions.pdfZoomIn')}
                disabled={zoom >= 2}
                onClick={() => {
                  setBusy(true)
                  setZoom(zoom + 0.25)
                }}
              >
                <Plus size={14} />
              </Button>
            </div>
          )}
          {busy && (
            <p
              role="status"
              className="flex items-center justify-center gap-2 text-[12px] text-muted"
            >
              <Loader2 size={14} className="animate-spin" />
              {t('sessions.pdfLoading')}
            </p>
          )}
          <div
            ref={canvasHost}
            className="max-h-[calc(100dvh-260px)] min-h-32 overflow-auto rounded-lg bg-canvas-deep p-3"
          />
          {text && (
            <details className="text-[12px] text-muted">
              <summary className="cursor-pointer">{t('sessions.pdfText')}</summary>
              <pre className="selectable max-h-52 overflow-auto whitespace-pre-wrap break-words p-3">
                {text}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, RefreshCw, X } from 'lucide-react'

import { Button } from '@/components/Button'
import { previewImage } from '@/lib/attachment-preview'
import { t } from '@/lib/i18n'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import type { SessionAttachment } from '@/lib/ipc'

export function AttachmentPreview({
  sessionId,
  attachment,
  onClose,
}: {
  sessionId: string
  attachment: SessionAttachment
  onClose: () => void
}) {
  const card = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let resource: string | null = null
    void previewImage(sessionId, attachment.id ?? '', controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return
        resource = URL.createObjectURL(blob)
        setUrl(resource)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => {
      controller.abort()
      if (resource) URL.revokeObjectURL(resource)
    }
  }, [sessionId, attachment.id, revision])

  const retry = () => {
    close.current?.focus()
    setFailed(false)
    setUrl(null)
    setRevision((value) => value + 1)
  }
  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => pressedBackdrop(event, onClose)}
      onKeyDown={(event) => holdFocus(card.current, event, onClose)}
      className="fixed inset-0 z-30 grid place-items-center bg-canvas-deep/70 p-4 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-preview-title"
        className="flex max-h-[calc(100dvh-32px)] w-full max-w-[960px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-lift"
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <h2
            id="attachment-preview-title"
            className="min-w-0 flex-1 break-words text-[15px] font-semibold"
          >
            {attachment.name || t('sessions.image')}
          </h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label={t('sessions.closePreview')}
            className="grid size-8 shrink-0 place-items-center rounded-control text-muted hover:bg-surface-2 hover:text-text"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="grid min-h-40 min-w-0 place-items-center overflow-auto p-4">
          {failed ? (
            <div role="status" className="space-y-4 text-center text-[13px] text-muted">
              <p>{t('sessions.previewFailed')}</p>
              <Button variant="secondary" onClick={retry}>
                <RefreshCw size={14} aria-hidden="true" />
                {t('sessions.previewRetry')}
              </Button>
            </div>
          ) : url ? (
            <img
              src={url}
              alt={attachment.name || t('sessions.image')}
              onError={() => setFailed(true)}
              className="max-h-[calc(100dvh-160px)] max-w-full object-contain"
            />
          ) : (
            <p role="status" className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              {t('sessions.previewLoading')}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

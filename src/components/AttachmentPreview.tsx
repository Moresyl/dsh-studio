import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Download, ImagePlus, Loader2, RefreshCw, X } from 'lucide-react'

import { Button } from '@/components/Button'
import { downloadFile, previewImage, previewText } from '@/lib/attachment-preview'
import {
  attachmentPreviewCanDismiss,
  attachmentPreviewKind,
  presentationImageIssue,
} from '@/lib/attachment-kind'
import { saveAttachment } from '@/lib/attachment-save'
import { t } from '@/lib/i18n'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import type { SessionAttachment } from '@/lib/ipc'
import { usePresentationEditor } from '@/state/presentation-editor'

const PdfPreview = lazy(() =>
  import('@/components/PdfPreview').catch(() => ({ default: PdfUnavailable })),
)

function PdfUnavailable() {
  return (
    <p role="status" className="p-4 text-[13px] text-muted">
      {t('sessions.pdfFailed')}
    </p>
  )
}

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
  const [image, setImage] = useState<Blob | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [pdf, setPdf] = useState<Blob | null>(null)
  const kind = attachmentPreviewKind(attachment)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const saving = useRef<AbortController | null>(null)
  const adding = useRef(false)
  const mounted = useRef(true)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [addState, setAddState] = useState<'idle' | 'adding' | 'added' | 'failed'>('idle')
  const editor = usePresentationEditor()
  const imageIssue = image ? presentationImageIssue(image) : null
  const dismiss = () => {
    if (attachmentPreviewCanDismiss(adding.current)) onClose()
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      saving.current?.abort()
    }
  }, [])

  const saveOriginal = async () => {
    if (saving.current) return
    const controller = new AbortController()
    saving.current = controller
    setSaveState('saving')
    try {
      const saved = await saveAttachment(sessionId, attachment, controller.signal)
      if (!controller.signal.aborted) setSaveState(saved ? 'saved' : 'idle')
    } catch {
      if (!controller.signal.aborted) setSaveState('failed')
    } finally {
      if (saving.current === controller) saving.current = null
    }
  }

  const addToPresentation = async () => {
    if (!image || imageIssue || !attachment.id || adding.current) return
    adding.current = true
    setAddState('adding')
    try {
      const inserted = await usePresentationEditor
        .getState()
        .insertImageAttachment(attachment.id, image)
      if (mounted.current) setAddState(inserted ? 'added' : 'failed')
    } catch {
      if (mounted.current) setAddState('failed')
    } finally {
      adding.current = false
    }
  }

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
    const read = kind === 'pdf' ? downloadFile : kind === 'text' ? previewText : previewImage
    void read(sessionId, attachment.id ?? '', controller.signal)
      .then(async (blob) => {
        if (kind === 'pdf') {
          if (!controller.signal.aborted) setPdf(blob)
          return
        }
        if (kind === 'text') {
          const content = await blob.text()
          if (!controller.signal.aborted) setText(content)
          return
        }
        if (controller.signal.aborted) return
        setImage(blob)
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
  }, [sessionId, attachment.id, kind, revision])

  const retry = () => {
    close.current?.focus()
    setFailed(false)
    setUrl(null)
    setImage(null)
    setText(null)
    setPdf(null)
    setRevision((value) => value + 1)
  }
  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => pressedBackdrop(event, dismiss)}
      onKeyDown={(event) => holdFocus(card.current, event, dismiss)}
      className="fixed inset-0 z-30 grid place-items-center bg-canvas-deep/70 p-4 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-preview-title"
        className="flex max-h-[calc(100dvh-32px)] w-full max-w-[960px] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-lift"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <h2
            id="attachment-preview-title"
            className="min-w-[12rem] flex-[1_1_16rem] break-words text-[15px] font-semibold"
          >
            {attachment.name || t(attachment.kind === 'file' ? 'sessions.file' : 'sessions.image')}
          </h2>
          {kind === 'image' && editor.document && (
            <Button
              variant="secondary"
              onClick={() => void addToPresentation()}
              disabled={
                !image ||
                imageIssue !== null ||
                editor.busy !== null ||
                addState === 'adding' ||
                addState === 'added'
              }
            >
              {addState === 'adding' ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : addState === 'added' ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <ImagePlus size={14} aria-hidden="true" />
              )}
              {t(
                addState === 'adding'
                  ? 'sessions.addingToPresentation'
                  : addState === 'added'
                    ? 'sessions.addedToPresentation'
                    : 'sessions.addToPresentation',
              )}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => void saveOriginal()}
            disabled={saveState === 'saving'}
          >
            {saveState === 'saving' ? (
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            ) : (
              <Download size={14} aria-hidden="true" />
            )}
            {t('sessions.saveAttachment')}
          </Button>
          <button
            ref={close}
            type="button"
            onClick={dismiss}
            disabled={addState === 'adding'}
            aria-label={t('sessions.closePreview')}
            className="grid size-8 shrink-0 place-items-center rounded-control text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {(saveState === 'saved' || saveState === 'failed') && (
          <p role="status" className="px-5 pt-3 text-[12px] text-muted">
            {t(
              saveState === 'saved' ? 'sessions.attachmentSaved' : 'sessions.attachmentSaveFailed',
            )}
          </p>
        )}
        {addState === 'failed' && (
          <p role="status" className="px-5 pt-3 text-[12px] text-danger">
            {editor.error || t('sessions.addToPresentationFailed')}
          </p>
        )}
        {image && imageIssue && (
          <p role="status" className="px-5 pt-3 text-[12px] text-muted">
            {t(
              imageIssue === 'size'
                ? 'sessions.presentationImageTooLarge'
                : 'sessions.presentationImageUnsupported',
            )}
          </p>
        )}
        <div className="grid min-h-40 min-w-0 place-items-center overflow-auto p-4">
          {failed ? (
            <div role="status" className="space-y-4 text-center text-[13px] text-muted">
              <p>
                {t(
                  attachment.kind === 'file'
                    ? 'sessions.filePreviewFailed'
                    : 'sessions.previewFailed',
                )}
              </p>
              <Button variant="secondary" onClick={retry}>
                <RefreshCw size={14} aria-hidden="true" />
                {t('sessions.previewRetry')}
              </Button>
            </div>
          ) : pdf ? (
            <Suspense fallback={<p role="status">{t('sessions.pdfLoading')}</p>}>
              <PdfPreview blob={pdf} />
            </Suspense>
          ) : text !== null ? (
            <pre
              tabIndex={0}
              aria-label={t('sessions.fileContent')}
              className="selectable max-h-[calc(100dvh-160px)] w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-canvas-deep p-4 font-mono text-[12px] leading-relaxed text-text"
            >
              {text || t('sessions.emptyFile')}
            </pre>
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

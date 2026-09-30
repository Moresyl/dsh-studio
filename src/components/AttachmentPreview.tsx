import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Download, ImagePlus, Loader2, RefreshCw, X } from 'lucide-react'

import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
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
    <p role="status" className="p-4 text-ui-base text-muted">
      {t('sessions.pdfFailed')}
    </p>
  )
}

/**
 * An attachment, opened over the transcript it was sent in.
 *
 * The dialog is a fixed height at most — 720px, or the window less its margins —
 * and what it holds has to fit inside that without a second scrollbar, so the
 * caps on the image, the text and the PDF page below are that height less what
 * the header and the padding take. Under that the panel simply shrinks to what
 * it is showing.
 */
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
      className="dialog-backdrop fixed inset-0 z-40 grid animate-fade place-items-center bg-canvas-deep/65 px-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-preview-title"
        className="dialog-panel flex max-h-[min(720px,calc(100vh-64px))] w-full max-w-[960px] animate-pop flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lift"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <h2
            id="attachment-preview-title"
            className="min-w-[12rem] flex-[1_1_16rem] break-words text-ui-lg font-semibold text-text"
          >
            {attachment.name || t(attachment.kind === 'file' ? 'sessions.file' : 'sessions.image')}
          </h2>
          {kind === 'image' && editor.document && (
            <Button
              variant="secondary"
              size="sm"
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
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : addState === 'added' ? (
                <Check aria-hidden="true" />
              ) : (
                <ImagePlus aria-hidden="true" />
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
            size="sm"
            onClick={() => void saveOriginal()}
            disabled={saveState === 'saving'}
          >
            {saveState === 'saving' ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Download aria-hidden="true" />
            )}
            {t('sessions.saveAttachment')}
          </Button>
          <IconButton
            ref={close}
            size="sm"
            icon={X}
            label={t('sessions.closePreview')}
            onClick={dismiss}
            disabled={addState === 'adding'}
          />
        </div>
        {(saveState === 'saved' || saveState === 'failed') && (
          <p role="status" className="px-5 pt-3 text-ui-sm text-muted">
            {t(
              saveState === 'saved' ? 'sessions.attachmentSaved' : 'sessions.attachmentSaveFailed',
            )}
          </p>
        )}
        {addState === 'failed' && (
          <p role="status" className="px-5 pt-3 text-ui-sm text-danger">
            {editor.error || t('sessions.addToPresentationFailed')}
          </p>
        )}
        {image && imageIssue && (
          <p role="status" className="px-5 pt-3 text-ui-sm text-muted">
            {t(
              imageIssue === 'size'
                ? 'sessions.presentationImageTooLarge'
                : 'sessions.presentationImageUnsupported',
            )}
          </p>
        )}
        <div className="grid min-h-40 min-w-0 flex-1 place-items-center overflow-auto px-5 py-4">
          {failed ? (
            <div role="status" className="space-y-4 text-center text-ui-base text-muted">
              <p>
                {t(
                  attachment.kind === 'file'
                    ? 'sessions.filePreviewFailed'
                    : 'sessions.previewFailed',
                )}
              </p>
              <Button variant="secondary" onClick={retry}>
                <RefreshCw aria-hidden="true" />
                {t('sessions.previewRetry')}
              </Button>
            </div>
          ) : pdf ? (
            <Suspense
              fallback={
                <p role="status" className="text-ui-base text-muted">
                  {t('sessions.pdfLoading')}
                </p>
              }
            >
              <PdfPreview blob={pdf} />
            </Suspense>
          ) : text !== null ? (
            <pre
              tabIndex={0}
              aria-label={t('sessions.fileContent')}
              className="selectable max-h-[min(584px,calc(100vh-200px))] w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-canvas-deep p-4 font-mono text-ui-sm text-text"
            >
              {text || t('sessions.emptyFile')}
            </pre>
          ) : url ? (
            <img
              src={url}
              alt={attachment.name || t('sessions.image')}
              onError={() => setFailed(true)}
              className="max-h-[min(584px,calc(100vh-200px))] max-w-full object-contain"
            />
          ) : (
            <p role="status" className="flex items-center gap-2 text-ui-base text-muted">
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

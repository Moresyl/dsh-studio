import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Copy, Info, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/Button'
import { t } from '@/lib/i18n'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { useDialog } from '@/state/dialog'

/**
 * The one modal in the app.
 *
 * A dialog earns its place by being rarer than the thing it interrupts: it is
 * for the question that has to be answered before an action that cannot be
 * taken back, and for a failure that would otherwise be easy to miss.
 * Everything routine belongs on the pane, where it does not stop the user to
 * be read.
 *
 * What makes it read as a window rather than as a web overlay is the small
 * stuff. It is the app's own panel, on the app's own surface, at the app's own
 * corner radius. The confirm button is focused when it opens, so Enter answers
 * it. Escape says no, and so does a click on the dimmed area behind it. Tab
 * stays inside. When it closes, focus goes back to whatever the user was on —
 * a modal that eats the caret is worse than no modal at all.
 */
export function Dialog() {
  const pending = useDialog((state) => state.pending)
  const settle = useDialog((state) => state.settle)

  const card = useRef<HTMLDivElement>(null)
  const accept = useRef<HTMLButtonElement>(null)
  const [copiedDetails, setCopiedDetails] = useState<string | null>(null)

  useEffect(() => {
    if (!pending) return

    const previous = document.activeElement
    accept.current?.focus()

    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [pending])

  if (!pending) return null

  const notice = pending.kind === 'error'
  const copied = notice && copiedDetails === pending.details
  const danger = notice || pending.tone !== 'brand'
  const Icon = danger ? TriangleAlert : Info

  const dismiss = () => {
    setCopiedDetails(null)
    settle(false)
  }

  const copyError = async () => {
    if (!notice) return
    try {
      await navigator.clipboard.writeText(pending.details)
      setCopiedDetails(pending.details)
    } catch {
      // The error remains selectable when clipboard access is unavailable.
    }
  }

  // Escape says no, Tab stays in here: outside a modal the rest of the window
  // is still focusable, and a caret that walks out of a question and into the
  // pane behind it is how a dialog stops being a dialog.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    holdFocus(card.current, event, dismiss)

  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => pressedBackdrop(event, dismiss)

  return (
    <div
      role="presentation"
      onMouseDown={onBackdrop}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-40 grid animate-fade place-items-center bg-canvas-deep/65 px-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-body"
        className="w-full max-w-[404px] animate-pop rounded-panel border border-line-strong bg-surface p-5 shadow-lift"
      >
        <div className="flex gap-3.5">
          <span
            aria-hidden="true"
            className={[
              'grid size-9 shrink-0 place-items-center rounded-[9px]',
              danger ? 'bg-danger/12 text-danger' : 'bg-brand/12 text-brand',
            ].join(' ')}
          >
            <Icon size={17} strokeWidth={2} />
          </span>

          <div className="min-w-0 flex-1 pt-0.5">
            <h2 id="dialog-title" className="text-[13.5px] leading-snug font-semibold text-text">
              {pending.title}
            </h2>
            <p id="dialog-body" className="mt-1.5 text-[12px] leading-relaxed text-muted">
              {pending.body}
            </p>

            {!notice && pending.subject && (
              <p className="selectable mt-2.5 truncate rounded-control border border-line bg-canvas-deep px-2.5 py-1.5 font-mono text-[11.5px] text-muted">
                {pending.subject}
              </p>
            )}

            {notice && (
              <pre className="selectable mt-2.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-canvas-deep px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-muted">
                {pending.details}
              </pre>
            )}
          </div>
        </div>

        {/* Cancel first, going through last — the order the platform this ships
            on puts them in, and the order the hand already expects. */}
        <div className="mt-5 flex justify-end gap-2">
          {notice ? (
            <>
              <Button variant="secondary" onClick={() => void copyError()}>
                <Copy size={13} aria-hidden="true" />
                {copied ? pending.copied : pending.copy}
              </Button>
              <Button ref={accept} variant="primary" onClick={dismiss}>
                {pending.close}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => settle(false)}>
                {t('dialog.cancel')}
              </Button>
              <Button
                ref={accept}
                variant={danger ? 'danger' : 'primary'}
                onClick={() => settle(true)}
              >
                {pending.confirm}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

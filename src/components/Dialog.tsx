import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { Info, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/Button'
import { t } from '@/lib/i18n'
import { useDialog } from '@/state/dialog'

/**
 * The one modal in the app.
 *
 * A dialog earns its place by being rarer than the thing it interrupts: it is
 * for the question that has to be answered before an action that cannot be
 * taken back, and for nothing else. Everything routine belongs on the pane,
 * where it does not stop the user to be read.
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

  useEffect(() => {
    if (!pending) return

    const previous = document.activeElement
    accept.current?.focus()

    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [pending])

  if (!pending) return null

  const danger = pending.tone !== 'brand'
  const Icon = danger ? TriangleAlert : Info

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      settle(false)
      return
    }

    // Tab stays in here. Outside a modal the rest of the window is still
    // focusable, and a caret that walks out of a question and into the pane
    // behind it is how a dialog stops being a dialog.
    if (event.key !== 'Tab') return

    const stops = Array.from(card.current?.querySelectorAll<HTMLElement>('button') ?? [])
    const first = stops.at(0)
    const last = stops.at(-1)
    if (!first || !last) return

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  // On the press and only on the backdrop itself: a selection that started on
  // the text in the card and ended out here is a drag, not a dismissal.
  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) settle(false)
  }

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

            {pending.subject && (
              <p className="selectable mt-2.5 truncate rounded-control border border-line bg-canvas-deep px-2.5 py-1.5 font-mono text-[11.5px] text-muted">
                {pending.subject}
              </p>
            )}
          </div>
        </div>

        {/* Cancel first, going through last — the order the platform this ships
            on puts them in, and the order the hand already expects. */}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => settle(false)}>
            {t('dialog.cancel')}
          </Button>
          <Button ref={accept} variant={danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
            {pending.confirm}
          </Button>
        </div>
      </div>
    </div>
  )
}

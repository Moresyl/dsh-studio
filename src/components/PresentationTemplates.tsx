import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from './Button'
import { PresentationSlideView } from './PresentationSlideView'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { t } from '@/lib/i18n'
import { createTemplate, TEMPLATE_KINDS } from '@/lib/presentation/templates'
import type { PresentationDocument } from '@/lib/presentation/document'

export function PresentationTemplates({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (document: PresentationDocument) => void
}) {
  const card = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [templates] = useState(() =>
    TEMPLATE_KINDS.map((kind) => ({
      kind,
      document: createTemplate(kind, {
        title: t(`deck.template.${kind}`),
        subtitle: t('deck.template.subtitle'),
        overview: t('deck.template.overview'),
        details: t('deck.template.details'),
        next: t('deck.template.next'),
        body: t('deck.template.body'),
        series: t('deck.template.series'),
      }),
    })),
  )
  const [selected, setSelected] = useState(templates[0]!)
  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])
  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-canvas-deep/65 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => pressedBackdrop(event, onClose)}
      onKeyDown={(event) => holdFocus(card.current, event, onClose)}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="presentation-templates-title"
        className="flex max-h-[calc(100dvh-32px)] w-full max-w-[940px] flex-col overflow-hidden rounded-[16px] border border-line-strong bg-surface shadow-lift"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="presentation-templates-title" className="text-[15px] font-semibold">
              {t('deck.templates')}
            </h2>
            <p className="mt-1 text-[12px] text-muted">{t('deck.template.hint')}</p>
          </div>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label={t('window.close')}
            className="grid size-8 place-items-center rounded-control text-muted hover:bg-control-fill focus-visible:outline-2 focus-visible:outline-brand"
          >
            <X size={17} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto p-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {templates.map((template) => (
              <button
                key={template.kind}
                type="button"
                aria-label={t(`deck.template.${template.kind}`)}
                aria-pressed={selected.kind === template.kind}
                onClick={() => setSelected(template)}
                className="min-w-0 rounded-panel border border-line p-3 text-left hover:bg-control-fill aria-pressed:border-brand focus-visible:outline-2 focus-visible:outline-brand"
              >
                <PresentationSlideView slide={template.document.slides[0]!} aspect="wide" />
                <span className="mt-3 block text-[13px] font-medium">
                  {t(`deck.template.${template.kind}`)}
                </span>
              </button>
            ))}
          </div>
          <h3 className="mb-3 mt-5 text-[12px] text-muted">
            {t('deck.template.pages', { count: selected.document.slides.length })}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {selected.document.slides.map((slide) => (
              <PresentationSlideView key={slide.id} slide={slide} aspect="wide" />
            ))}
          </div>
        </div>
        <div className="flex justify-end border-t border-line px-5 py-4">
          <Button onClick={() => onCreate(selected.document)}>{t('deck.template.create')}</Button>
        </div>
      </div>
    </div>
  )
}

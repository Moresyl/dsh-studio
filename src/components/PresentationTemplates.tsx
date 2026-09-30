import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from './Button'
import { IconButton } from './IconButton'
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
      className="dialog-backdrop fixed inset-0 z-40 grid animate-fade place-items-center bg-canvas-deep/65 px-8 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => pressedBackdrop(event, onClose)}
      onKeyDown={(event) => holdFocus(card.current, event, onClose)}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="presentation-templates-title"
        className="dialog-panel flex max-h-[min(720px,calc(100vh-64px))] w-full max-w-[940px] animate-pop flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lift"
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="presentation-templates-title" className="text-ui-lg font-semibold text-text">
              {t('deck.templates')}
            </h2>
            <p className="mt-1 text-ui-sm text-faint">{t('deck.template.hint')}</p>
          </div>
          <IconButton ref={close} size="sm" icon={X} label={t('window.close')} onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {templates.map((template) => (
              <button
                key={template.kind}
                type="button"
                aria-label={t(`deck.template.${template.kind}`)}
                aria-pressed={selected.kind === template.kind}
                onClick={() => setSelected(template)}
                className="card card--interactive min-w-0 p-3 text-left aria-pressed:border-brand aria-pressed:bg-surface-2"
              >
                <PresentationSlideView slide={template.document.slides[0]!} aspect="wide" />
                <span className="mt-3 block text-ui-base font-medium text-text">
                  {t(`deck.template.${template.kind}`)}
                </span>
              </button>
            ))}
          </div>
          <h3 className="caption mt-5 mb-3">
            {t('deck.template.pages', { count: selected.document.slides.length })}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {selected.document.slides.map((slide) => (
              <PresentationSlideView key={slide.id} slide={slide} aspect="wide" />
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <Button onClick={() => onCreate(selected.document)}>{t('deck.template.create')}</Button>
        </div>
      </div>
    </div>
  )
}

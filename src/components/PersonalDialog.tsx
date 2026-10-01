import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '@/components/IconButton'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { t } from '@/lib/i18n'

export function PersonalDialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  const heading = useId()
  useEffect(() => {
    const previous = document.activeElement
    panel.current
      ?.querySelector<HTMLElement>('input:not([disabled]), textarea, button:not([disabled])')
      ?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])
  return (
    <div
      role="presentation"
      className="dialog-backdrop fixed inset-0 z-30 grid place-items-center bg-canvas-deep/65 px-5 backdrop-blur-[2px]"
      onMouseDown={(event) => pressedBackdrop(event, onClose)}
      onKeyDown={(event) => holdFocus(panel.current, event, onClose)}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={heading}
        className={`dialog-panel flex max-h-[85vh] w-full flex-col gap-4 overflow-y-auto rounded-xl border border-line-strong bg-surface p-5 shadow-lift ${wide ? 'max-w-[1040px]' : 'max-w-[640px]'}`}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={heading} className="text-ui-lg font-semibold">
            {title}
          </h2>
          <IconButton icon={X} label={t('organize.close')} onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  )
}

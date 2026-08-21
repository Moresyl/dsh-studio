import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { CheckCircle2, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/Button'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { holdFocus, pressedBackdrop } from '@/lib/modal'

/**
 * One startup read for one durable recovery result.
 *
 * The result is acknowledged only from the button, so a render, StrictMode
 * replay, or a window being hidden can never erase recovery evidence before it
 * was actually shown to a person.
 */
export function PluginRecoveryDialog() {
  const [notice, setNotice] = useState<ipc.PluginRecoveryNotice | null>(null)
  const card = useRef<HTMLDivElement>(null)
  const close = async () => {
    await ipc.pluginRecoveryAcknowledge()
    setNotice(null)
  }

  useEffect(() => {
    let active = true
    void ipc.pluginRecoveryNotice().then((value) => {
      if (active) setNotice(value)
    })
    return () => {
      active = false
    }
  }, [])

  if (notice === null) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    holdFocus(card.current, event, () => void close())
  const onBackdrop = (event: MouseEvent<HTMLDivElement>) =>
    pressedBackdrop(event, () => void close())
  const Icon = notice.restored ? CheckCircle2 : TriangleAlert

  return (
    <div
      role="presentation"
      onMouseDown={onBackdrop}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 grid place-items-center bg-canvas-deep/75 p-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="alertdialog"
        aria-modal="true"
        aria-label={t('recovery.title')}
        className="w-full max-w-[480px] rounded-panel border border-line-strong bg-surface p-5 shadow-lift"
      >
        <div className="flex items-start gap-3">
          <Icon
            size={20}
            className={notice.restored ? 'mt-0.5 shrink-0 text-ok' : 'mt-0.5 shrink-0 text-danger'}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-text">{t('recovery.title')}</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              {notice.restored ? t('recovery.restored') : t('recovery.failed')}
            </p>
            <dl className="mt-3 grid grid-cols-[84px_1fr] gap-x-3 gap-y-1.5 rounded-control border border-line bg-canvas-deep/55 p-3 text-[11px]">
              <dt className="text-faint">{t('recovery.profile')}</dt>
              <dd className="truncate font-mono text-muted">{notice.profile}</dd>
              <dt className="text-faint">{t('recovery.operation')}</dt>
              <dd className="truncate font-mono text-muted">{notice.operation}</dd>
              <dt className="text-faint">{t('recovery.subject')}</dt>
              <dd className="truncate font-mono text-muted">{notice.subject}</dd>
            </dl>
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => void close()}>
            {t('recovery.continue')}
          </Button>
        </div>
      </div>
    </div>
  )
}

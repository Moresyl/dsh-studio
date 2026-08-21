import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { RotateCcw, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/Button'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { holdFocus } from '@/lib/modal'

/** Recovery remains in the native shell even when the hosted profile cannot boot. */
export function ProfileRecoveryDialog() {
  const [notice, setNotice] = useState<ipc.ProfileStartupRecovery | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    void ipc.profileRecoveryNotice().then((value) => {
      if (active) setNotice(value)
    })
    return () => {
      active = false
    }
  }, [])

  if (notice === null) return null

  const close = async () => {
    await ipc.profileRecoveryAcknowledge()
    setNotice(null)
  }
  const disable = async (name: string) => {
    setWorking(name)
    setError(null)
    try {
      setNotice(await ipc.profileRecoveryDisablePlugin(name))
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setWorking(null)
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    holdFocus(card.current, event, () => void close())

  return (
    <div
      role="presentation"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 grid place-items-center bg-canvas-deep/80 p-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="alertdialog"
        aria-modal="true"
        aria-label={t('profileRecovery.title')}
        className="w-full max-w-[520px] rounded-panel border border-line-strong bg-surface p-5 shadow-lift"
      >
        <div className="flex items-start gap-3">
          <ShieldAlert size={21} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-text">{t('profileRecovery.title')}</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              {notice.recoveredProfile
                ? t('profileRecovery.rolledBack', {
                    failed: notice.failedProfile,
                    recovered: notice.recoveredProfile,
                  })
                : t('profileRecovery.noFallback', { failed: notice.failedProfile })}
            </p>
            <pre className="mt-3 max-h-24 overflow-auto whitespace-pre-wrap rounded-control border border-line bg-canvas-deep/55 p-3 text-[10.5px] leading-relaxed text-faint">
              {notice.reason}
            </pre>

            {notice.plugins.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-[11.5px] text-muted">{t('profileRecovery.disableHint')}</p>
                <div className="max-h-40 space-y-1.5 overflow-auto">
                  {notice.plugins.map((name) => (
                    <div
                      key={name}
                      className="flex items-center gap-3 rounded-control border border-line bg-canvas-deep/35 px-3 py-2"
                    >
                      <code className="min-w-0 flex-1 truncate text-[11px] text-text">{name}</code>
                      <Button disabled={working !== null} onClick={() => void disable(name)}>
                        {working === name
                          ? t('profileRecovery.disabling')
                          : t('profileRecovery.disable')}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {error && <p className="mt-3 text-[11px] text-danger">{error}</p>}
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => void close()}>
            <RotateCcw size={13} aria-hidden="true" />
            {t('profileRecovery.continue')}
          </Button>
        </div>
      </div>
    </div>
  )
}

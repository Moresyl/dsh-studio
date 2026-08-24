import { useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { CheckCircle2, Database, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'

import { Button } from '@/components/Button'
import { t } from '@/lib/i18n'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { usePlugins } from '@/state/plugins'

interface CatalogSourcesDialogProps {
  onClose: () => void
}

/** Add and remove public Schema-compatible discovery endpoints. */
export function CatalogSourcesDialog({ onClose }: CatalogSourcesDialogProps) {
  const sources = usePlugins((state) => state.sources)
  const sourceWorking = usePlugins((state) => state.sourceWorking)
  const sourceHealth = usePlugins((state) => state.sourceHealth)
  const checkingSource = usePlugins((state) => state.checkingSource)
  const addSource = usePlugins((state) => state.addSource)
  const removeSource = usePlugins((state) => state.removeSource)
  const checkSource = usePlugins((state) => state.checkSource)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const card = useRef<HTMLDivElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (adding || label.trim() === '' || endpoint.trim() === '') return
    setAdding(true)
    try {
      if (await addSource(label, endpoint)) {
        setLabel('')
        setEndpoint('')
      }
    } finally {
      setAdding(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    holdFocus(card.current, event, onClose)
  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => pressedBackdrop(event, onClose)

  return (
    <div
      role="presentation"
      onMouseDown={onBackdrop}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-40 grid place-items-center bg-canvas-deep/75 p-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={t('plugins.sources.title')}
        className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden rounded-panel border border-line-strong bg-surface shadow-lift"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <Database size={17} className="text-brand" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold text-text">{t('plugins.sources.title')}</h2>
            <p className="mt-0.5 text-[11px] text-faint">{t('plugins.sources.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('plugins.close')}
            className="grid size-7 place-items-center rounded-control text-faint hover:bg-surface-2 hover:text-text"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ul className="overflow-hidden rounded-control border border-line">
            {sources.map((source) => {
              const health = sourceHealth[source.id]
              return (
                <li
                key={source.id}
                className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[12px] font-medium text-text">
                      {source.label}
                    </span>
                    {source.active && (
                      <span className="rounded-full bg-ok/10 px-1.5 py-0.5 text-[9.5px] text-ok">
                        {t('plugins.sources.active')}
                      </span>
                    )}
                    {source.builtIn && (
                      <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] text-faint">
                        {t('plugins.builtin')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-faint">
                    {source.endpoint ?? source.kind}
                  </p>
                  {health && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9.5px] text-faint">
                      <span className="inline-flex items-center gap-1 text-ok">
                        <CheckCircle2 size={10} aria-hidden="true" />
                        {t('plugins.sources.conformant')}
                      </span>
                      <span>{health.contract}</span>
                      <span>
                        {health.installable}/{health.items}{' '}
                        {t('plugins.sources.installable')}
                      </span>
                      <span>{health.latencyMs} ms</span>
                      {health.warnings.map((warning) => (
                        <span key={warning} className="w-full text-warn">
                          {warning}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void checkSource(source.id)}
                  disabled={sourceWorking || checkingSource !== null}
                  aria-label={t('plugins.sources.check')}
                  className="grid size-7 shrink-0 place-items-center rounded-control text-faint hover:bg-brand/10 hover:text-brand disabled:opacity-50"
                >
                  {checkingSource === source.id ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <RefreshCw size={13} aria-hidden="true" />
                  )}
                </button>
                {!source.builtIn && (
                  <button
                    type="button"
                    onClick={() => void removeSource(source.id)}
                    disabled={sourceWorking}
                    aria-label={t('plugins.sources.remove')}
                    className="grid size-7 shrink-0 place-items-center rounded-control text-faint hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                )}
                </li>
              )
            })}
          </ul>

          <form
            onSubmit={(event) => void submit(event)}
            className="mt-4 rounded-control border border-line bg-canvas-deep/45 p-3"
          >
            <h3 className="caption">{t('plugins.sources.add')}</h3>
            <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
              {t('plugins.sources.security')}
            </p>
            <div className="mt-3 grid gap-2">
              <input
                value={label}
                aria-label={t('plugins.sources.name')}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('plugins.sources.name')}
                maxLength={64}
                className="h-8 rounded-control border border-line bg-surface px-2.5 text-[11.5px] text-text outline-none focus:border-brand"
              />
              <input
                value={endpoint}
                aria-label={t('plugins.sources.endpoint')}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://catalog.example/plugins.json"
                inputMode="url"
                spellCheck={false}
                className="h-8 rounded-control border border-line bg-surface px-2.5 font-mono text-[10.5px] text-text outline-none focus:border-brand"
              />
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                type="submit"
                variant="primary"
                disabled={
                  adding || sourceWorking || label.trim() === '' || endpoint.trim() === ''
                }
              >
                {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                {adding ? t('plugins.sources.validating') : t('plugins.sources.addAction')}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

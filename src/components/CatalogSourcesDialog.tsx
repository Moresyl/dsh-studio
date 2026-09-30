import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { CheckCircle2, Database, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'

import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
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

  useEffect(() => {
    const previous = document.activeElement
    card.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

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
      className="dialog-backdrop fixed inset-0 z-40 grid animate-fade place-items-center bg-canvas-deep/65 px-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={t('plugins.sources.title')}
        className="dialog-panel flex max-h-[min(720px,calc(100vh-64px))] w-full max-w-[560px] animate-pop flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lift"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-4">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-brand"
          >
            <Database size={18} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-ui-lg font-semibold text-text">{t('plugins.sources.title')}</h2>
            <p className="mt-0.5 text-ui-sm text-faint">{t('plugins.sources.subtitle')}</p>
          </div>
          <IconButton icon={X} size="sm" label={t('plugins.close')} onClick={onClose} />
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <ul className="list-card">
            {sources.map((source) => {
              const health = sourceHealth[source.id]
              return (
                <li key={source.id} className="list-row">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-ui-base font-medium text-text">
                        {source.label}
                      </span>
                      {source.active && <Badge tone="ok">{t('plugins.sources.active')}</Badge>}
                      {source.builtIn && <Badge>{t('plugins.builtin')}</Badge>}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-ui-sm text-faint">
                      {source.endpoint ?? source.kind}
                    </p>
                    {health && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-faint">
                        <Badge tone="ok">
                          <CheckCircle2 aria-hidden="true" />
                          {t('plugins.sources.conformant')}
                        </Badge>
                        <span>{health.contract}</span>
                        <span>
                          {health.installable}/{health.items} {t('plugins.sources.installable')}
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
                  <IconButton
                    icon={checkingSource === source.id ? Loader2 : RefreshCw}
                    size="sm"
                    label={t('plugins.sources.check')}
                    onClick={() => void checkSource(source.id)}
                    disabled={sourceWorking || checkingSource !== null}
                    className={checkingSource === source.id ? '[&>svg]:animate-spin' : undefined}
                  />
                  {!source.builtIn && (
                    <IconButton
                      icon={Trash2}
                      variant="danger-ghost"
                      size="sm"
                      label={t('plugins.sources.remove')}
                      onClick={() => void removeSource(source.id)}
                      disabled={sourceWorking}
                    />
                  )}
                </li>
              )
            })}
          </ul>

          <form onSubmit={(event) => void submit(event)} className="card flex flex-col gap-3 p-4">
            <div>
              <h3 className="text-ui-base font-medium text-text">{t('plugins.sources.add')}</h3>
              <p className="mt-1 text-ui-sm text-faint">{t('plugins.sources.security')}</p>
            </div>
            <div className="grid gap-2">
              <input
                value={label}
                aria-label={t('plugins.sources.name')}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('plugins.sources.name')}
                maxLength={64}
                className="field-control w-full"
              />
              <input
                value={endpoint}
                aria-label={t('plugins.sources.endpoint')}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://catalog.example/plugins.json"
                inputMode="url"
                spellCheck={false}
                className="field-control w-full font-mono text-ui-sm"
              />
            </div>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                disabled={adding || sourceWorking || label.trim() === '' || endpoint.trim() === ''}
              >
                {adding ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Plus aria-hidden="true" />
                )}
                {adding ? t('plugins.sources.validating') : t('plugins.sources.addAction')}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

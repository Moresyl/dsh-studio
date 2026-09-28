import { useEffect, useRef } from 'react'
import {
  ArrowDownToLine,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'

import { Button } from '@/components/Button'
import { UpdateProgress } from '@/components/UpdateProgress'
import { openExternalUrl } from '@/lib/external-url'
import { t } from '@/lib/i18n'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { notesForDisplay } from '@/lib/updater'
import { ask } from '@/state/dialog'
import { reportAction } from '@/state/failure'
import { useReleaseHistory } from '@/state/releases'
import { useUpdate } from '@/state/update'

export function VersionHistory({ onClose }: { onClose: () => void }) {
  const card = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const state = useReleaseHistory()
  const installing = useUpdate((state) => state.installing)
  const checking = useUpdate((state) => state.checking)
  const install = useUpdate((state) => state.installVersion)
  const entry = state.entries.find((entry) => entry.version === state.selected)
  const review = state.review

  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    void useReleaseHistory.getState().load()
    return () => {
      useReleaseHistory.getState().dispose()
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  const dismiss = () => {
    if (!installing) onClose()
  }
  const refresh = () => {
    close.current?.focus()
    void state.load(state.page)
  }
  const apply = async () => {
    if (!review || installing || checking) return
    const accepted = await ask({
      title: t(
        review.direction === 'older' ? 'versions.confirmDowngrade' : 'versions.confirmInstall',
      ),
      body: t(review.direction === 'older' ? 'versions.downgradeBody' : 'versions.installBody'),
      subject: `${review.currentVersion} → ${review.version}`,
      confirm: t('versions.installRestart'),
      tone: review.direction === 'older' ? 'danger' : 'brand',
    })
    if (accepted) await install(review)
  }

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-canvas-deep/65 p-4 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => pressedBackdrop(event, dismiss)}
      onKeyDown={(event) => holdFocus(card.current, event, dismiss)}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-history-title"
        className="flex max-h-[min(680px,calc(100dvh-32px))] w-full max-w-[920px] animate-pop flex-col overflow-hidden rounded-[16px] border border-line-strong bg-surface shadow-lift"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2
              id="version-history-title"
              className="flex items-center gap-2 text-[15px] font-semibold text-text"
            >
              <History size={17} aria-hidden="true" />
              {t('versions.title')}
            </h2>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
              {t('versions.subtitle')}
            </p>
          </div>
          <button
            ref={close}
            type="button"
            aria-label={t('versions.close')}
            aria-disabled={installing}
            onClick={dismiss}
            className="grid size-8 shrink-0 place-items-center rounded-control text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-brand"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)] max-[620px]:grid-cols-1">
          <div className="flex min-h-0 flex-col border-r border-line bg-canvas-deep/30 max-[620px]:max-h-[180px] max-[620px]:border-r-0 max-[620px]:border-b">
            <div className="flex items-center justify-between px-3 py-2 text-[11.5px] text-muted">
              <span>{t('versions.page', { page: state.page })}</span>
              <button
                type="button"
                aria-label={t('versions.refresh')}
                disabled={state.loading || installing}
                onClick={refresh}
                className="grid size-7 place-items-center rounded-control hover:bg-surface-2 disabled:opacity-50"
              >
                <RefreshCw
                  size={13}
                  className={state.loading ? 'animate-spin' : ''}
                  aria-hidden="true"
                />
              </button>
            </div>
            {state.error && (
              <p
                role="alert"
                className="selectable px-3 pb-3 text-[12px] leading-relaxed text-danger"
              >
                {state.error}
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-busy={state.loading}>
              {state.entries.map((item) => (
                <button
                  key={item.version}
                  type="button"
                  disabled={state.loading || installing}
                  aria-pressed={state.selected === item.version}
                  onClick={() => void state.select(item.version)}
                  className={`mb-1 flex w-full flex-col gap-1 rounded-control px-3 py-2.5 text-left disabled:opacity-50 ${state.selected === item.version ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2/60 hover:text-text'}`}
                >
                  <span className="flex items-center justify-between gap-2 text-[13px] font-medium tabular-nums">
                    <span>{item.version}</span>
                    <span className="text-[10px] font-normal text-faint">
                      {t(`versions.${item.direction}`)}
                    </span>
                  </span>
                  <span className="text-[11px] text-faint">{item.published.slice(0, 10)}</span>
                </button>
              ))}
              {!state.loading && !state.error && state.entries.length === 0 && (
                <p className="px-2 py-5 text-[12px] text-muted">{t('versions.empty')}</p>
              )}
            </div>
            <div className="flex justify-between border-t border-line px-3 py-2">
              <button
                type="button"
                aria-label={t('versions.previous')}
                disabled={state.page <= 1 || state.loading || installing}
                onClick={() => void state.load(state.page - 1)}
                className="grid size-7 place-items-center rounded-control text-muted hover:bg-surface-2 disabled:opacity-40"
              >
                <ChevronLeft size={15} />
              </button>
              <button
                type="button"
                aria-label={t('versions.next')}
                disabled={!state.hasMore || state.loading || installing}
                onClick={() => void state.load(state.page + 1)}
                className="grid size-7 place-items-center rounded-control text-muted hover:bg-surface-2 disabled:opacity-40"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden p-5">
            {entry ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-[17px] font-semibold tracking-tight text-text">
                    DSH Studio {entry.version}
                  </h3>
                  <button
                    type="button"
                    onClick={() => void reportAction(() => openExternalUrl(entry.url))}
                    className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-text"
                  >
                    {t('about.release')}
                    <ArrowUpRight size={13} />
                  </button>
                </div>
                {state.reviewing && (
                  <p role="status" className="flex items-center gap-2 text-[12px] text-muted">
                    <Loader2 size={14} className="animate-spin" />
                    {t('versions.reviewing')}
                  </p>
                )}
                {state.reviewError && (
                  <div className="flex flex-col items-start gap-3">
                    <p
                      role="alert"
                      className="selectable max-h-48 overflow-y-auto text-[12px] leading-relaxed text-danger"
                    >
                      {state.reviewError}
                    </p>
                    <Button variant="secondary" onClick={() => void state.select(entry.version)}>
                      {t('versions.retry')}
                    </Button>
                  </div>
                )}
                {!entry.hasUpdater && (
                  <p className="text-[12px] leading-relaxed text-muted">
                    {t('versions.noUpdater')}
                  </p>
                )}
                {review && (
                  <>
                    <p className="text-[11.5px] text-muted">
                      {t('versions.package', { size: (review.bytes / 1024 / 1024).toFixed(1) })}
                    </p>
                    <div
                      tabIndex={0}
                      role="region"
                      aria-label={t('about.release')}
                      className="selectable min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words pr-2 text-[12.5px] leading-6 text-text focus-visible:outline-2 focus-visible:outline-brand"
                    >
                      {notesForDisplay(review.notes) || t('versions.noNotes')}
                    </div>
                    <p className="border-t border-line pt-3 text-[11.5px] leading-relaxed text-muted">
                      {t('versions.runtimeNotice')}
                    </p>
                    {!review.canInstall && (
                      <p className="text-[11.5px] text-muted">
                        {t(
                          review.installBlock === 'rpmDowngrade'
                            ? 'versions.rpmDowngrade'
                            : 'versions.development',
                        )}
                      </p>
                    )}
                    {installing ? (
                      <UpdateProgress />
                    ) : (
                      <div className="flex justify-end">
                        <Button
                          variant="primary"
                          disabled={!review.canInstall || checking}
                          onClick={() => void apply()}
                        >
                          <ArrowDownToLine size={14} />
                          {t(
                            review.direction === 'older'
                              ? 'versions.downgrade'
                              : review.direction === 'current'
                                ? 'versions.reinstall'
                                : 'versions.install',
                          )}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <p className="m-auto text-[12.5px] text-muted">
                {state.loading ? t('versions.loading') : t('versions.choose')}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

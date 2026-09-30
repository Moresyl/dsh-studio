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

import { Badge, type BadgeTone } from '@/components/Badge'
import { Button } from '@/components/Button'
import { Empty } from '@/components/Empty'
import { IconButton } from '@/components/IconButton'
import { UpdateProgress } from '@/components/UpdateProgress'
import { openExternalUrl } from '@/lib/external-url'
import { t } from '@/lib/i18n'
import type { ApplicationReleaseSummary } from '@/lib/ipc'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { notesForDisplay } from '@/lib/updater'
import { ask } from '@/state/dialog'
import { reportAction } from '@/state/failure'
import { useReleaseHistory } from '@/state/releases'
import { useUpdate } from '@/state/update'

/**
 * How a release reads next to the one that is installed. The running version is
 * the fact worth colouring; newer is worth a glance; older only reports itself.
 */
const DIRECTION_TONE: Record<ApplicationReleaseSummary['direction'], BadgeTone> = {
  current: 'ok',
  newer: 'info',
  older: 'neutral',
}

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
    // The app's own dialog is mounted after this one, at the same layer, so the
    // install confirmation asked from in here paints over it.
    <div
      className="dialog-backdrop fixed inset-0 z-40 grid animate-fade place-items-center bg-canvas-deep/65 px-8 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => pressedBackdrop(event, dismiss)}
      onKeyDown={(event) => holdFocus(card.current, event, dismiss)}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-history-title"
        className="dialog-panel flex max-h-[min(720px,calc(100vh-64px))] w-full max-w-[920px] animate-pop flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lift"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-4">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-brand"
          >
            <History size={18} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="version-history-title" className="text-ui-lg font-semibold text-text">
              {t('versions.title')}
            </h2>
            <p className="mt-0.5 text-ui-sm text-faint">{t('versions.subtitle')}</p>
          </div>
          <IconButton
            ref={close}
            icon={X}
            size="sm"
            label={t('versions.close')}
            aria-disabled={installing}
            onClick={dismiss}
          />
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[208px_minmax(0,1fr)] max-[620px]:grid-cols-1 max-[620px]:grid-rows-[auto_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col border-r border-line bg-canvas-deep/30 max-[620px]:max-h-44 max-[620px]:border-r-0 max-[620px]:border-b">
            <div className="flex items-center justify-between py-2 pr-2 pl-5">
              <span className="caption">{t('versions.page', { page: state.page })}</span>
              <IconButton
                icon={RefreshCw}
                size="sm"
                label={t('versions.refresh')}
                disabled={state.loading || installing}
                onClick={refresh}
                className={state.loading ? '[&>svg]:animate-spin' : undefined}
              />
            </div>
            {state.error && (
              <p
                role="alert"
                className="selectable mx-2 mb-2 shrink-0 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger [overflow-wrap:anywhere]"
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
                  className={`mb-1 flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-40 ${state.selected === item.version ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2/70 hover:text-text'}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-ui-base font-medium">
                      {item.version}
                    </span>
                    <Badge tone={DIRECTION_TONE[item.direction]}>
                      {t(`versions.${item.direction}`)}
                    </Badge>
                  </span>
                  <span className="text-ui-sm text-faint tabular-nums">
                    {item.published.slice(0, 10)}
                  </span>
                </button>
              ))}
              {!state.loading && !state.error && state.entries.length === 0 && (
                <p className="px-3 py-4 text-ui-base text-muted">{t('versions.empty')}</p>
              )}
            </div>
            <div className="flex justify-between border-t border-line p-2">
              <IconButton
                icon={ChevronLeft}
                size="sm"
                label={t('versions.previous')}
                disabled={state.page <= 1 || state.loading || installing}
                onClick={() => void state.load(state.page - 1)}
              />
              <IconButton
                icon={ChevronRight}
                size="sm"
                label={t('versions.next')}
                disabled={!state.hasMore || state.loading || installing}
                onClick={() => void state.load(state.page + 1)}
              />
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden px-5 py-4">
            {entry ? (
              <>
                <div>
                  <h3 className="text-ui-lg font-semibold text-text">DSH Studio {entry.version}</h3>
                  {review && (
                    <p className="mt-1 text-ui-sm text-muted">
                      {t('versions.package', { size: (review.bytes / 1024 / 1024).toFixed(1) })}
                    </p>
                  )}
                </div>
                {state.reviewing && (
                  <p role="status" className="flex items-center gap-2 text-ui-base text-muted">
                    <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                    {t('versions.reviewing')}
                  </p>
                )}
                {state.reviewError && (
                  <div className="flex flex-col items-start gap-3">
                    <p
                      role="alert"
                      className="selectable max-h-48 w-full overflow-y-auto rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger [overflow-wrap:anywhere]"
                    >
                      {state.reviewError}
                    </p>
                    <Button variant="secondary" onClick={() => void state.select(entry.version)}>
                      {t('versions.retry')}
                    </Button>
                  </div>
                )}
                {!entry.hasUpdater && (
                  <p className="text-ui-base text-muted">{t('versions.noUpdater')}</p>
                )}
                {review && (
                  <>
                    <div
                      tabIndex={0}
                      role="region"
                      aria-label={t('about.release')}
                      className="selectable min-h-0 flex-1 overflow-y-auto pr-2 text-ui-base break-words whitespace-pre-wrap text-text"
                    >
                      {notesForDisplay(review.notes) || t('versions.noNotes')}
                    </div>
                    <p className="border-t border-line pt-3 text-ui-sm text-muted">
                      {t('versions.runtimeNotice')}
                    </p>
                    {!review.canInstall && (
                      <p className="text-ui-sm text-muted">
                        {t(
                          review.installBlock === 'rpmDowngrade'
                            ? 'versions.rpmDowngrade'
                            : 'versions.development',
                        )}
                      </p>
                    )}
                    {installing && <UpdateProgress />}
                  </>
                )}
              </>
            ) : (
              <div className="m-auto">
                <Empty
                  icon={state.loading ? Loader2 : History}
                  spin={state.loading}
                  message={state.loading ? t('versions.loading') : t('versions.choose')}
                />
              </div>
            )}
          </div>
        </div>

        {entry && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
            <Button
              variant="secondary"
              onClick={() => void reportAction(() => openExternalUrl(entry.url))}
            >
              {t('about.release')}
              <ArrowUpRight aria-hidden="true" />
            </Button>
            {review && (
              <Button
                variant="primary"
                disabled={!review.canInstall || checking || installing}
                onClick={() => void apply()}
              >
                <ArrowDownToLine aria-hidden="true" />
                {t(
                  review.direction === 'older'
                    ? 'versions.downgrade'
                    : review.direction === 'current'
                      ? 'versions.reinstall'
                      : 'versions.install',
                )}
              </Button>
            )}
          </footer>
        )}
      </div>
    </div>
  )
}

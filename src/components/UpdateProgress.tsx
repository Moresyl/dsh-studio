import { Loader2 } from 'lucide-react'

import { Button } from '@/components/Button'
import { t } from '@/lib/i18n'
import { useUpdate } from '@/state/update'

export function UpdateProgress() {
  const progress = useUpdate((state) => state.progress)
  const cancelling = useUpdate((state) => state.cancelling)
  const cancel = useUpdate((state) => state.cancelInstall)
  const phase = progress?.phase ?? 'downloading'
  const percent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null
  const label = cancelling
    ? t('versions.cancelling')
    : phase === 'checking'
      ? t('about.checking')
      : phase === 'verifying'
        ? t('versions.verifying')
        : phase === 'installing'
          ? t('about.installing')
          : percent === null
            ? t('about.downloading')
            : t('about.downloadingPercent', { percent })
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-ui-base text-muted">
        <span className="flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          {label}
        </span>
        {phase !== 'installing' && (
          <Button variant="secondary" disabled={cancelling} onClick={() => void cancel()}>
            {t('versions.cancelDownload')}
          </Button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-1 overflow-hidden rounded-full bg-line-strong"
      >
        {/* The same two bars the environment's installs draw: a fill that
            follows the bytes when the total is known, and the slow drift when
            it is not. */}
        <div
          className={
            percent === null
              ? 'h-full w-1/4 animate-drift rounded-full bg-brand'
              : 'h-full rounded-full bg-brand transition-[width] duration-200 ease-[var(--ease-out-soft)]'
          }
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

import { t } from '@/lib/i18n'
import type { Status } from '@/lib/ipc'

/** Dot colour and whether it breathes, per phase. */
const APPEARANCE: Record<Status['phase'], { color: string; live: boolean }> = {
  stopped: { color: 'var(--color-faint)', live: false },
  starting: { color: 'var(--color-brand)', live: true },
  ready: { color: 'var(--color-ok)', live: false },
  restarting: { color: 'var(--color-warn)', live: true },
  failed: { color: 'var(--color-danger)', live: false },
}

/** The one line that says what the harness is doing. */
export function StatusPill({ status }: { status: Status }) {
  const { color, live } = APPEARANCE[status.phase]
  const label =
    status.phase === 'restarting'
      ? t('status.restarting', { attempt: status.attempt })
      : t(`status.${status.phase}`)

  return (
    <div
      className="inline-flex h-7 items-center gap-2 rounded-full bg-surface/60 px-3 text-[12.5px] text-muted backdrop-blur-md hairline"
      role="status"
      aria-live="polite"
    >
      <span className="relative grid size-2 place-items-center">
        {live && (
          <span
            className="absolute size-2 animate-ping rounded-full opacity-70"
            style={{ backgroundColor: color }}
          />
        )}
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }}
        />
      </span>
      {label}
    </div>
  )
}

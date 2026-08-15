import type { LucideIcon } from 'lucide-react'
import { Check, CircleAlert, Loader2, Minus } from 'lucide-react'

export type CheckState = 'ok' | 'missing' | 'neutral'

/** The one thing that would fix this row, offered on the row itself. */
export interface CheckAction {
  label: string
  icon: LucideIcon
  busy?: boolean
  run: () => void
}

export interface CheckItem {
  key: string
  icon: LucideIcon
  label: string
  value: string
  /** Full text when `value` had to be shortened to fit. */
  title?: string
  state: CheckState
  action?: CheckAction
}

const BADGE: Record<CheckState, { icon: LucideIcon; className: string }> = {
  ok: { icon: Check, className: 'text-ok bg-ok/12' },
  missing: { icon: CircleAlert, className: 'text-danger bg-danger/12' },
  neutral: {
    icon: Minus,
    className: 'text-faint bg-[color-mix(in_oklab,var(--color-faint)_14%,transparent)]',
  },
}

/**
 * The pre-flight checks, as one grouped card.
 *
 * A row that reports something missing carries the fix next to it — being told
 * what is wrong and then left to solve it elsewhere is the failure this avoids.
 */
export function CheckList({ items }: { items: CheckItem[] }) {
  return (
    <ul className="overflow-hidden rounded-panel bg-surface/60 shadow-panel backdrop-blur-xl hairline">
      {items.map((item, index) => {
        const badge = BADGE[item.state]
        const BadgeIcon = badge.icon
        const ActionIcon = item.action?.icon

        return (
          <li
            key={item.key}
            className={`flex items-center gap-3 px-4 py-3 ${index > 0 ? 'border-t border-line' : ''}`}
          >
            <span
              className={`grid size-6 shrink-0 place-items-center rounded-full ${badge.className}`}
            >
              <BadgeIcon size={13} strokeWidth={2.5} aria-hidden="true" />
            </span>

            <item.icon size={15} className="shrink-0 text-faint" aria-hidden="true" />

            <span className="shrink-0 text-[13.5px] text-text">{item.label}</span>

            <span
              className="ml-auto truncate text-right font-mono text-[12px] text-muted"
              title={item.title ?? item.value}
            >
              {item.value}
            </span>

            {item.action && ActionIcon && (
              <button
                type="button"
                onClick={item.action.run}
                disabled={item.action.busy}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-brand/15 px-3 text-[12px] font-medium text-brand transition duration-150 hover:bg-brand/25 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-55"
              >
                {item.action.busy ? (
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                ) : (
                  <ActionIcon size={12} strokeWidth={2.4} aria-hidden="true" />
                )}
                {item.action.label}
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

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
  label: string
  value: string
  /** Full text when `value` had to be shortened to fit. */
  title?: string
  state: CheckState
  action?: CheckAction
}

const GLYPH: Record<CheckState, { icon: LucideIcon; className: string }> = {
  ok: { icon: Check, className: 'text-ok' },
  missing: { icon: CircleAlert, className: 'text-danger' },
  neutral: { icon: Minus, className: 'text-faint' },
}

/**
 * The pre-flight checks, as one bordered list.
 *
 * Rows are 34px and the state is a bare glyph rather than a badge on a coloured
 * disc: a check list is read by scanning down the left edge, and at that job a
 * dense column of marks beats a column of decorated pills.
 *
 * A row that reports something missing carries the fix next to it — being told
 * what is wrong and then left to solve it elsewhere is the failure this avoids.
 */
export function CheckList({ items }: { items: CheckItem[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-canvas-deep/50">
      {items.map((item) => {
        const glyph = GLYPH[item.state]
        const GlyphIcon = glyph.icon
        const ActionIcon = item.action?.icon

        return (
          <li key={item.key} className="flex h-[34px] items-center gap-2 px-2.5">
            <GlyphIcon
              size={13}
              strokeWidth={2.6}
              className={`shrink-0 ${glyph.className}`}
              aria-hidden="true"
            />

            <span className="shrink-0 text-[12.5px] text-text">{item.label}</span>

            <span
              className="ml-auto truncate text-right font-mono text-[11.5px] text-muted"
              data-hint={item.title ?? item.value}
            >
              {item.value}
            </span>

            {item.action && ActionIcon && (
              <button
                type="button"
                onClick={item.action.run}
                disabled={item.action.busy}
                className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[4px] border border-line-strong bg-surface-2 px-2 text-[11.5px] font-medium text-text transition duration-100 enabled:hover:brightness-[1.2] enabled:active:brightness-95 disabled:opacity-55"
              >
                {item.action.busy ? (
                  <Loader2 size={11} className="animate-spin" aria-hidden="true" />
                ) : (
                  <ActionIcon size={11} strokeWidth={2.4} aria-hidden="true" />
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

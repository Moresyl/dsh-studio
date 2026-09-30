import type { LucideIcon } from 'lucide-react'
import { Check, CircleAlert, Loader2, Minus } from 'lucide-react'

import { Button } from '@/components/Button'

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
 * The state is a bare glyph rather than a badge on a coloured disc: a check list
 * is read by scanning down the left edge, and at that job a dense column of
 * marks beats a column of decorated pills.
 *
 * A row that reports something missing carries the fix next to it — being told
 * what is wrong and then left to solve it elsewhere is the failure this avoids.
 */
export function CheckList({ items }: { items: CheckItem[] }) {
  return (
    <ul className="list-card">
      {items.map((item) => {
        const glyph = GLYPH[item.state]
        const GlyphIcon = glyph.icon
        const ActionIcon = item.action?.icon

        return (
          <li key={item.key} className="list-row">
            <GlyphIcon
              size={16}
              strokeWidth={2.4}
              className={`shrink-0 ${glyph.className}`}
              aria-hidden="true"
            />

            <span className="shrink-0 text-ui-base text-text">{item.label}</span>

            <span
              className="ml-auto truncate text-right font-mono text-ui-sm text-muted"
              data-hint={item.title ?? item.value}
            >
              {item.value}
            </span>

            {item.action && ActionIcon && (
              <Button
                variant="secondary"
                size="sm"
                onClick={item.action.run}
                disabled={item.action.busy}
              >
                {item.action.busy ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <ActionIcon aria-hidden="true" />
                )}
                {item.action.label}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

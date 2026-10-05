import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface SegmentedItem<T extends string> {
  value: T
  label: string
  /** Drawn beside the label, or alone when the control is `iconOnly`. */
  icon?: LucideIcon
  /** Tooltip; defaults to the label, which is what an icon-only segment needs. */
  hint?: string
  /** A count or a marker after the label. */
  trailing?: ReactNode
  disabled?: boolean
}

interface SegmentedProps<T extends string> {
  items: readonly SegmentedItem<T>[]
  value: T
  onChange: (value: T) => void
  /** Names the group, since the segments alone do not say what they choose. */
  label: string
  size?: 'sm' | 'md'
  /** Draw the icons and keep the labels for the tooltip and the accessible name. */
  iconOnly?: boolean
  /**
   * Show icon and label, and drop the label below 760px. For the title bar,
   * where the strip is the only thing that has to give when the window narrows.
   */
  responsive?: boolean
  className?: string
}

/**
 * Several named choices, all on screen, the current one raised.
 *
 * Segments rather than underlined tabs, because these strips sit inside pane
 * headers and toolbars where an underline would be a second horizontal rule next
 * to the one already there. The selected segment uses a raised neutral surface
 * and a subtle shadow so its state is visible in either theme.
 *
 * It answers `aria-pressed`, one per segment, which is what the capture harness
 * and the tests look for. The group is one control, so the pressed one is the
 * state of the whole rather than several buttons that happen to look related.
 * Re-selecting the segment you are on is a change to nothing, so its handler is
 * dropped: leaving it attached is what makes an active segment hover like
 * something that would do something.
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  size = 'md',
  iconOnly = false,
  responsive = false,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={[
        'segmented',
        size === 'sm' && 'segmented--sm',
        iconOnly && 'segmented--icons',
        responsive && 'segmented--responsive',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {items.map((item) => {
        const active = item.value === value
        const Icon = item.icon
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            aria-label={iconOnly || responsive ? item.label : undefined}
            data-hint={iconOnly || responsive ? (item.hint ?? item.label) : item.hint}
            disabled={item.disabled}
            onClick={active ? undefined : () => onChange(item.value)}
            className="segmented__item"
          >
            {Icon && <Icon strokeWidth={1.9} aria-hidden="true" />}
            {!iconOnly && <span className="segmented__label">{item.label}</span>}
            {!iconOnly && item.trailing}
          </button>
        )
      })}
    </div>
  )
}

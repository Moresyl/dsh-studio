import type { ComponentPropsWithRef } from 'react'
import type { LucideIcon } from 'lucide-react'

import { buttonClass, type ButtonVariant, type ControlSize } from '@/components/Button'

interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'aria-label' | 'children'> {
  /** Names the control for the tooltip and for anything reading it aloud. */
  label: string
  icon: LucideIcon
  variant?: ButtonVariant
  size?: ControlSize
  /** The icon's stroke, for the rare place a heavier mark carries the meaning. */
  strokeWidth?: number
}

/**
 * A button that is only a picture.
 *
 * The label is required, not optional, because an icon alone is a guess: it is
 * the accessible name, and it is the tooltip, and a control with neither is one
 * that only the person who drew it can use. The box is square at the size's
 * height, and the icon is the size that suits it — none of that is the caller's
 * to override.
 */
export function IconButton({
  label,
  icon: Icon,
  variant = 'ghost',
  size = 'sm',
  strokeWidth = 1.9,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      data-hint={label}
      className={buttonClass({ variant, size, icon: true, className })}
      {...rest}
    >
      <Icon strokeWidth={strokeWidth} aria-hidden="true" />
    </button>
  )
}

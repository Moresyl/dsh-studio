import type { ComponentPropsWithRef, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'

/**
 * Four heights, and the reasons for each are in the `.btn` rules in `app.css`.
 * Short version: `xs` is furniture, `sm` repeats, `md` is the default, `lg` is
 * the one thing a screen is for.
 */
export type ControlSize = 'xs' | 'sm' | 'md' | 'lg'

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant
  size?: ControlSize
  children: ReactNode
}

/**
 * The class list for anything that has to look like a button but cannot be one
 * — a link that opens a page, a label wrapped around a file input. Kept next to
 * the component so the two cannot drift apart.
 */
export function buttonClass({
  variant = 'primary',
  size = 'md',
  icon = false,
  className,
}: {
  variant?: ButtonVariant
  size?: ControlSize
  icon?: boolean
  className?: string
}): string {
  return ['btn', `btn--${size}`, `btn--${variant}`, icon && 'btn--icon', className]
    .filter(Boolean)
    .join(' ')
}

/**
 * The button. Every colour and number comes from the `.btn` rules; this only
 * picks which of them apply, so a screen cannot end up with a fifth size by
 * passing a `className` that says `h-[26px]`.
 *
 * Callers that want less height ask for `size="sm"`, and callers that want the
 * screen's one action to stand out ask for `size="lg"` — nothing else about the
 * geometry is theirs to change.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button type="button" className={buttonClass({ variant, size, className })} {...rest}>
      {children}
    </button>
  )
}

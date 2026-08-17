import type { ComponentPropsWithRef, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: Variant
  children: ReactNode
}

/**
 * One control height for the whole app.
 *
 * 30px is what a desktop toolbar button measures; the 44px full-width gradient
 * bar this replaced measures like a web call-to-action, which is a different
 * kind of software making a different kind of promise.
 *
 * A disabled button stays hit-testable — no `pointer-events: none` — so the
 * pointer still reads `not-allowed` over it and its hint still explains itself.
 * Every reaction is gated on `enabled:` instead, which is what keeps a dead
 * control from lighting up when it is hovered.
 */
const BASE =
  'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-control px-3 text-[12.5px] font-medium transition duration-100 ease-[var(--ease-out-soft)] select-none disabled:opacity-40'

const VARIANT: Record<Variant, string> = {
  // Flat accent, dark ink. The one saturated element on the surface, which is
  // what makes it findable without an animation or a glow.
  primary: 'bg-brand text-on-brand enabled:hover:brightness-[1.08] enabled:active:brightness-95',
  secondary:
    'border border-line-strong bg-surface-2 text-text enabled:hover:brightness-[1.15] enabled:active:brightness-95',
  // The press has to be visible on a variant that has no fill to darken, so it
  // borrows the hover surface and goes one step further.
  ghost:
    'px-2 text-muted enabled:hover:bg-surface-2 enabled:hover:text-text enabled:active:bg-line',
  // Filled, like the primary, because the button that removes something should
  // be as easy to aim at as the one that keeps it — the safety is in the
  // question above it, not in making the answer hard to hit.
  danger: 'bg-danger text-on-danger enabled:hover:brightness-[1.08] enabled:active:brightness-95',
}

export function Button({ variant = 'primary', className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={[BASE, VARIANT[variant], className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
}

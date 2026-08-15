import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  children: ReactNode
}

/**
 * One control height for the whole app.
 *
 * 30px is what a desktop toolbar button measures; the 44px full-width gradient
 * bar this replaced measures like a web call-to-action, which is a different
 * kind of software making a different kind of promise.
 */
const BASE =
  'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-control px-3 text-[12.5px] font-medium transition duration-100 ease-[var(--ease-out-soft)] select-none disabled:pointer-events-none disabled:opacity-40'

const VARIANT: Record<Variant, string> = {
  // Flat accent, dark ink. The one saturated element on the surface, which is
  // what makes it findable without an animation or a glow.
  primary: 'bg-brand text-[#07101f] hover:brightness-[1.08] active:brightness-95',
  secondary:
    'border border-line-strong bg-surface-2 text-text hover:border-line-strong hover:brightness-[1.15] active:brightness-95',
  ghost: 'px-2 text-muted hover:bg-surface-2 hover:text-text',
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

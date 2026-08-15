import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  children: ReactNode
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-control text-[14px] font-medium transition duration-150 ease-[var(--ease-out-soft)] disabled:pointer-events-none disabled:opacity-45'

const VARIANT: Record<Variant, string> = {
  // The brand gradient reads as light in both themes, so the label is ink.
  primary:
    'h-11 w-full bg-linear-to-r from-brand-cyan via-brand to-brand-violet text-[#050c1c] shadow-[0_10px_30px_-12px_var(--color-brand)] hover:brightness-110 active:scale-[0.99]',
  ghost:
    'h-9 px-3 text-muted hover:bg-[color-mix(in_oklab,var(--color-text)_8%,transparent)] hover:text-text active:scale-[0.99]',
}

export function Button({ variant = 'primary', className, children, ...rest }: ButtonProps) {
  return (
    <button type="button" className={[BASE, VARIANT[variant], className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </button>
  )
}

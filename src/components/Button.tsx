import type { ComponentPropsWithRef, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: Variant
  children: ReactNode
}

/** The default ChatGPT desktop button: 20px high, 12px text and a 6px radius. */
const BASE =
  'inline-flex h-5 shrink-0 items-center justify-center gap-[3px] rounded-[6px] px-1.5 text-[12px] leading-none font-normal whitespace-nowrap transition-[background-color,border-color,color,filter,opacity,transform] duration-150 ease-out select-none disabled:opacity-40 enabled:active:scale-[0.97]'

const VARIANT: Record<Variant, string> = {
  // Flat accent, dark ink. The one saturated element on the surface, which is
  // what makes it findable without an animation or a glow.
  primary: 'bg-brand text-on-brand enabled:hover:brightness-[1.08] enabled:active:brightness-95',
  secondary:
    'border border-control-border bg-transparent text-text enabled:hover:border-control-border-hover enabled:hover:bg-control-fill enabled:active:bg-control-fill-hover',
  // The press has to be visible on a variant that has no fill to darken, so it
  // borrows the hover surface and goes one step further.
  ghost:
    'text-muted enabled:hover:bg-control-fill enabled:hover:text-text enabled:active:bg-control-fill-hover',
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

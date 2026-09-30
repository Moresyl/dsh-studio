import type { HTMLAttributes } from 'react'

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
}

/**
 * A short fact about the thing next to it: current, community, too old.
 *
 * It is a rectangle with a small corner and never a pill, because a pill is the
 * shape of something that can be pressed and a badge only reports. Colour is for
 * the tone and the tone is for meaning — `ok`, `warn` and `danger` say how the
 * fact should be read, and `neutral` says only that it is one.
 */
export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={['badge', tone !== 'neutral' && `badge--${tone}`, className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </span>
  )
}

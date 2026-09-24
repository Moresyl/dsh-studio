import { ChevronDown } from 'lucide-react'
import type { ComponentPropsWithoutRef } from 'react'

type Density = 'default' | 'compact' | 'small'

interface SelectControlProps extends ComponentPropsWithoutRef<'select'> {
  'aria-label': string
  containerClassName?: string
  density?: Density
}

const DENSITY: Record<Density, string> = {
  default: '',
  compact: 'field-control--compact',
  small: 'field-control--small',
}

export function SelectControl({
  className,
  containerClassName,
  density = 'default',
  children,
  'aria-label': ariaLabel,
  ...props
}: SelectControlProps) {
  return (
    <span className={['select-control', containerClassName].filter(Boolean).join(' ')}>
      <select
        aria-label={ariaLabel}
        className={[
          'field-control select-control__input',
          DENSITY[density],
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="select-control__chevron" strokeWidth={2} aria-hidden="true" />
    </span>
  )
}

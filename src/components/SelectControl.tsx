import { ChevronDown } from 'lucide-react'
import {
  Children,
  isValidElement,
  useId,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import { useMenu, type MenuEntry } from '@/state/menu'

type Density = 'default' | 'compact' | 'small'

interface SelectControlProps {
  'aria-label': string
  value?: string
  defaultValue?: string
  disabled?: boolean
  onValueChange?: (value: string) => void
  children: ReactNode
  containerClassName?: string
  className?: string
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
  value,
  defaultValue,
  disabled = false,
  onValueChange,
  'aria-label': ariaLabel,
}: SelectControlProps) {
  const owner = useId()
  const menuOwner = useMenu((state) => state.owner)
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
  const options = Children.toArray(children).flatMap((child) => {
    if (!isValidElement<ComponentPropsWithoutRef<'option'>>(child) || child.type !== 'option') {
      return []
    }

    const optionValue = String(child.props.value ?? child.props.children ?? '')
    return [
      {
        value: optionValue,
        label: child.props.label ?? child.props.children,
        disabled: child.props.disabled ?? false,
      },
    ]
  })
  const currentValue =
    value ?? uncontrolledValue ?? options.find((option) => !option.disabled)?.value ?? ''
  const current = options.find((option) => option.value === currentValue) ?? options[0]
  const open = (target: HTMLButtonElement) => {
    if (disabled || options.length === 0) return

    const entries: MenuEntry[] = options.map((option) => ({
      label: String(option.label ?? option.value),
      selected: option.value === currentValue,
      disabled: option.disabled,
      run: () => {
        if (value === undefined) setUncontrolledValue(option.value)
        onValueChange?.(option.value)
      },
    }))
    const box = target.getBoundingClientRect()
    useMenu.getState().show(box.left, box.bottom + 4, entries, { owner, minWidth: box.width })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    open(event.currentTarget)
  }

  return (
    <span className={['select-control', containerClassName].filter(Boolean).join(' ')}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={menuOwner === owner}
        aria-controls={menuOwner === owner ? `${owner}-menu` : undefined}
        data-selected={currentValue !== ''}
        disabled={disabled}
        onClick={(event) => open(event.currentTarget)}
        onKeyDown={onKeyDown}
        className={['select-control__trigger', DENSITY[density], className]
          .filter(Boolean)
          .join(' ')}
      >
        <span className="min-w-0 flex-1 truncate text-left">{current?.label}</span>
        <ChevronDown className="select-control__chevron" strokeWidth={2.2} aria-hidden="true" />
      </button>
    </span>
  )
}

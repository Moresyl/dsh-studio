import { Loader2 } from 'lucide-react'

interface SwitchProps {
  on: boolean
  /** A write is in flight; the track holds its old state until it lands. */
  busy?: boolean
  disabled?: boolean
  /** Named for the tooltip and for anything reading the control aloud. */
  label: string
  onChange: (on: boolean) => void
}

/**
 * On or off, for a thing that is already there.
 *
 * A switch and not a checkbox, because the two are different promises: a
 * checkbox is a choice that takes effect when something else is pressed, and a
 * switch acts the moment it is thrown. Everything this one is used for writes
 * immediately, so it has to be the second one.
 *
 * The knob is the only part that changes colour, and it changes to keep contrast
 * against both track colours in both palettes — a switch nobody can see the
 * state of is a switch that gets thrown twice.
 */
export function Switch({ on, busy = false, disabled = false, label, onChange }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-hint={label}
      disabled={disabled || busy}
      onClick={() => onChange(!on)}
      className={[
        // `transition` rather than `transition-colors`: the hover lift is a
        // filter, and a switch that brightens without easing reads as a flicker.
        'relative h-[18px] w-[32px] shrink-0 rounded-full transition duration-150 ease-[var(--ease-out-soft)]',
        // A switch is the one control here with no label of its own to change,
        // so the track has to answer the pointer or there is nothing to confirm
        // the hit is landing.
        'enabled:hover:brightness-[1.14] enabled:active:brightness-95 disabled:opacity-45',
        on ? 'bg-ok' : 'bg-surface-2 hairline',
      ].join(' ')}
    >
      {busy ? (
        <Loader2
          size={11}
          className={`absolute top-[3.5px] animate-spin ${on ? 'left-[17px] text-canvas' : 'left-[4px] text-faint'}`}
          aria-hidden="true"
        />
      ) : (
        <span
          aria-hidden="true"
          className={[
            'absolute top-[2px] size-[14px] rounded-full shadow-panel transition-all duration-150 ease-[var(--ease-out-soft)]',
            on ? 'left-[16px] bg-canvas' : 'left-[2px] bg-faint',
          ].join(' ')}
        />
      )}
    </button>
  )
}

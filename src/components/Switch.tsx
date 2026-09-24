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
 * The white thumb stays constant while the track carries state, matching the
 * desktop chat control and remaining obvious in both palettes.
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
        'relative h-[19px] w-[32px] shrink-0 rounded-full transition duration-150 ease-[var(--ease-out-soft)]',
        // A switch is the one control here with no label of its own to change,
        // so the track has to answer the pointer or there is nothing to confirm
        // the hit is landing.
        'enabled:active:brightness-95',
        on
          ? 'bg-switch-on enabled:hover:brightness-[1.08]'
          : 'bg-switch-off enabled:hover:bg-switch-off-hover disabled:bg-switch-off-disabled',
      ].join(' ')}
    >
      {busy ? (
        <Loader2
          size={11}
          className={`absolute top-[4px] animate-spin ${on ? 'left-[17px] text-white' : 'left-[4px] text-text'}`}
          aria-hidden="true"
        />
      ) : (
        <span
          aria-hidden="true"
          className={[
            'absolute top-[3px] size-[13px] rounded-full bg-white shadow-[0_1px_2px_#0003] transition-all duration-150 ease-[var(--ease-out-soft)]',
            on ? 'left-[16px]' : 'left-[3px]',
          ].join(' ')}
        />
      )}
    </button>
  )
}

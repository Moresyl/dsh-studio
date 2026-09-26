/**
 * The two behaviours every modal in this app owes the keyboard and the mouse.
 *
 * Kept here rather than in the one component that first needed them, because a
 * second modal that forgot either of these would not look broken — it would
 * just be the one where Escape does nothing and Tab walks out into the pane
 * behind it, which is the kind of difference nobody reports and everybody feels.
 */
import type { KeyboardEvent, MouseEvent } from 'react'

/**
 * Answer Escape, and keep Tab inside `card`.
 *
 * Include every visible keyboard stop, including custom controls. A loading
 * transition can remove the focused control, so focus outside the ring must
 * also return to the card before the browser walks into the pane behind it.
 */
export function holdFocus(
  card: HTMLElement | null,
  event: KeyboardEvent<HTMLElement>,
  dismiss: () => void,
): void {
  if (event.key === 'Escape') {
    // Stopped here: a search field further up answers Escape by clearing
    // itself, and the modal in front of it is what the key is for right now.
    event.stopPropagation()
    dismiss()
    return
  }

  if (event.key !== 'Tab') return

  if (!card) return
  const stops = Array.from(
    card.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, a[href], [tabindex], [contenteditable="true"]',
    ),
  ).filter(
    (stop) =>
      stop.tabIndex >= 0 &&
      !stop.matches(':disabled') &&
      !stop.closest('[hidden], [inert]') &&
      stop.getClientRects().length > 0,
  )
  const first = stops.at(0)
  const last = stops.at(-1)
  if (!first || !last) {
    event.preventDefault()
    card.focus()
    return
  }

  if (!stops.includes(document.activeElement as HTMLElement)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return
  }

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

/**
 * Dismiss on a press that both began and landed on the dimmed area.
 *
 * On the press rather than the click, and only when the target is the backdrop
 * itself: a selection that started on the text in the card and ended out here
 * is a drag, not a dismissal.
 */
export function pressedBackdrop(event: MouseEvent<HTMLElement>, dismiss: () => void): void {
  if (event.target === event.currentTarget) dismiss()
}

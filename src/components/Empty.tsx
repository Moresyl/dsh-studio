import type { LucideIcon } from 'lucide-react'

/**
 * What a pane says when it has nothing to show.
 *
 * Two lines rather than one, because "nothing here" is only half an answer: the
 * other half is whether that is a problem, and what would put something here.
 * The icon is the pane's own subject rather than a warning sign — an empty list
 * is the ordinary state of a machine nobody has used yet, not a fault.
 */
export function Empty({
  icon: Icon,
  spin,
  message,
  hint,
}: {
  icon: LucideIcon
  spin?: boolean
  message: string
  hint?: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-8 py-12 text-center">
      <Icon
        size={22}
        strokeWidth={1.4}
        className={`text-faint opacity-60 ${spin ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      <p className="text-[12.5px] text-muted">{message}</p>
      {hint && <p className="max-w-[46ch] text-[11.5px] leading-relaxed text-faint">{hint}</p>}
    </div>
  )
}

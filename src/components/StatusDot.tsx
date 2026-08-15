import type { Tone } from '@/lib/status'

/**
 * The indicator itself: a dot, and a ring while the phase is still moving.
 *
 * Small enough to sit inside a 22px status bar without crowding the line it
 * belongs to, which is the size everything else here is designed around.
 */
export function StatusDot({ tone, size = 7 }: { tone: Tone; size?: number }) {
  return (
    <span
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {tone.live && (
        <span
          className="absolute animate-ping rounded-full opacity-60"
          style={{ width: size, height: size, backgroundColor: tone.color }}
        />
      )}
      <span
        className="rounded-full"
        style={{
          width: size,
          height: size,
          backgroundColor: tone.color,
          boxShadow: `0 0 6px ${tone.color}`,
        }}
      />
    </span>
  )
}

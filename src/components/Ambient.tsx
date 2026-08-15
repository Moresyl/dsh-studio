/**
 * The light behind the window.
 *
 * Two slow radial washes and a film of noise. Both are pure paint — no blur
 * filter, no layout — so the effect costs one composited layer rather than a
 * per-frame blur of half the window.
 */

const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

export function Ambient() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute -top-[38%] -left-[22%] size-[44rem] animate-drift-a rounded-full opacity-35"
        style={{
          background: 'radial-gradient(circle, var(--color-brand-cyan) 0%, transparent 62%)',
        }}
      />
      <div
        className="absolute -right-[24%] -bottom-[40%] size-[48rem] animate-drift-b rounded-full opacity-30"
        style={{
          background: 'radial-gradient(circle, var(--color-brand-violet) 0%, transparent 64%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{ backgroundImage: NOISE }}
      />
    </div>
  )
}

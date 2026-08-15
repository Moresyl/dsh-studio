/**
 * The light on the panel surface.
 *
 * One static wash and a film of noise, both at the edge of visibility. It used
 * to be two slowly drifting colour blobs — which is the signature of a landing
 * page, not of a tool window. What is left does the one job worth doing: stop a
 * large flat fill from reading as painted cardboard.
 *
 * Pure paint, no blur filter and no layout, so it costs a single composited
 * layer and nothing per frame.
 */

const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

export function Ambient() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute -top-56 -left-32 size-[32rem] rounded-full opacity-[0.13]"
        style={{
          background: 'radial-gradient(circle, var(--color-brand) 0%, transparent 68%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.022] mix-blend-overlay"
        style={{ backgroundImage: NOISE }}
      />
    </div>
  )
}

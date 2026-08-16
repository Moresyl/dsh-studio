import { useMemo } from 'react'

import type { QrMatrix } from '@/lib/ipc'

/** Modules of clear margin. The specification asks for four; two scans fine on
 * a screen and keeps the symbol large inside a panel that has its own padding. */
const QUIET = 2

interface QrCodeProps {
  matrix: QrMatrix
  /** Rendered edge length in pixels. The symbol itself is resolution-free. */
  size?: number
  label: string
}

/**
 * The pairing code, drawn from the module grid the Rust side encoded.
 *
 * Deliberately not theme-aware. Everything else in this window follows the
 * system palette, but a QR symbol is read by a camera looking for dark modules
 * on a light field, and plenty of scanners refuse an inverted one outright — so
 * this stays black on white and is framed as a white plate instead. A code that
 * matched the theme and did not scan would be a worse design decision than a
 * white rectangle in a dark window.
 *
 * One `<path>` rather than a rect per module: a version 4 symbol is a thousand
 * modules, and a thousand SVG nodes is a real cost for a picture that never
 * animates.
 */
export function QrCode({ matrix, size = 200, label }: QrCodeProps) {
  const span = matrix.size + QUIET * 2

  const path = useMemo(() => {
    let drawn = ''
    for (let y = 0; y < matrix.size; y += 1) {
      for (let x = 0; x < matrix.size; x += 1) {
        if (matrix.modules[y * matrix.size + x]) {
          drawn += `M${x + QUIET} ${y + QUIET}h1v1h-1z`
        }
      }
    }
    return drawn
  }, [matrix])

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label={label}
      // Modules land on integer coordinates, so antialiasing here would only
      // soften the edges a camera is trying to threshold.
      shapeRendering="crispEdges"
      className="rounded-[10px] shadow-lift"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}

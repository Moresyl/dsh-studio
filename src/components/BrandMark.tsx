import { useId } from 'react'

interface BrandMarkProps {
  size?: number
  className?: string
}

/**
 * The application mark: a prompt caret and its cursor rule.
 *
 * Same geometry as `assets/brand/icon.svg`, redrawn here so the in-app mark
 * scales and picks up its own gradient rather than being a resized bitmap.
 */
export function BrandMark({ size = 64, className }: BrandMarkProps) {
  const id = useId()
  const tile = `${id}-tile`
  const halo = `${id}-halo`
  const glyph = `${id}-glyph`
  const sheen = `${id}-sheen`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      role="img"
      aria-label="DSH Studio"
    >
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#2A3F82" />
          <stop offset="0.55" stopColor="#141E4A" />
          <stop offset="1" stopColor="#070B20" />
        </linearGradient>
        <radialGradient id={halo} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#5C8BFF" stopOpacity="0.38" />
          <stop offset="1" stopColor="#5C8BFF" stopOpacity="0" />
        </radialGradient>
        {/* User space, not the default object bounding box: the cursor rule is a
            horizontal line whose bounding box has zero height, and an
            objectBoundingBox gradient makes such an element vanish outright. */}
        <linearGradient
          id={glyph}
          gradientUnits="userSpaceOnUse"
          x1="264"
          y1="270"
          x2="760"
          y2="754"
        >
          <stop offset="0" stopColor="#8FF6FF" />
          <stop offset="0.5" stopColor="#6E9BFF" />
          <stop offset="1" stopColor="#AC8CFF" />
        </linearGradient>
        <linearGradient id={sheen} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.17" />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect width="1024" height="1024" rx="232" fill={`url(#${tile})`} />
      <ellipse cx="512" cy="500" rx="420" ry="360" fill={`url(#${halo})`} />
      <rect width="1024" height="1024" rx="232" fill={`url(#${sheen})`} />
      <rect
        x="7"
        y="7"
        width="1010"
        height="1010"
        rx="225"
        fill="none"
        stroke="#8FB2FF"
        strokeOpacity="0.24"
        strokeWidth="14"
      />

      <g
        fill="none"
        stroke={`url(#${glyph})`}
        strokeWidth="104"
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(0 -8)"
      >
        <path d="M254 322 L470 512 L254 702" />
        <path d="M596 702 L770 702" />
      </g>
    </svg>
  )
}

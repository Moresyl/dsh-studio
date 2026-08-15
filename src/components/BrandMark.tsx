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
          <stop offset="0" stopColor="#243A7A" />
          <stop offset="0.55" stopColor="#141E4A" />
          <stop offset="1" stopColor="#080C22" />
        </linearGradient>
        <linearGradient id={glyph} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#7FF3FF" />
          <stop offset="0.5" stopColor="#6E9BFF" />
          <stop offset="1" stopColor="#A98CFF" />
        </linearGradient>
        <linearGradient id={sheen} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.16" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect width="1024" height="1024" rx="232" fill={`url(#${tile})`} />
      <rect width="1024" height="1024" rx="232" fill={`url(#${sheen})`} />
      <rect
        x="6"
        y="6"
        width="1012"
        height="1012"
        rx="226"
        fill="none"
        stroke="#8FB2FF"
        strokeOpacity="0.22"
        strokeWidth="12"
      />

      <g
        fill="none"
        stroke={`url(#${glyph})`}
        strokeWidth="98"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M330 322 L556 512 L330 702" />
        <path d="M646 702 L790 702" />
      </g>
    </svg>
  )
}

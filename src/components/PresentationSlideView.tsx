import {
  presentationSize,
  type PresentationDocument,
  type PresentationSlide,
  type SlideElement,
  type ChartElement,
} from '@/lib/presentation/document'

interface Props {
  slide: PresentationSlide
  aspect: PresentationDocument['aspect']
  selected?: string | null
  onSelect?: (id: string) => void
}

/** Data-only editing preview. Object order follows the saved slide's stacking order. */
export function PresentationSlideView({ slide, aspect, selected, onSelect }: Props) {
  const size = presentationSize(aspect)
  return (
    <svg
      viewBox={`0 0 ${size.width} ${size.height}`}
      className="block h-auto w-full rounded-[4px] shadow-lift"
      aria-label={slide.title}
      role={onSelect ? 'group' : 'img'}
      style={{ background: `#${slide.background}` }}
    >
      {slide.elements.map((element) => (
        <g
          key={element.id}
          transform={`translate(${element.x} ${element.y}) rotate(${element.rotation} ${element.width / 2} ${element.height / 2})`}
          role={onSelect ? 'button' : undefined}
          tabIndex={onSelect ? 0 : undefined}
          aria-label={
            onSelect
              ? element.kind === 'text'
                ? element.text || element.id
                : element.id
              : undefined
          }
          aria-pressed={onSelect ? selected === element.id : undefined}
          onClick={onSelect ? () => onSelect(element.id) : undefined}
          onKeyDown={
            onSelect
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onSelect(element.id)
                  }
                }
              : undefined
          }
          className={onSelect ? 'group cursor-pointer outline-none' : undefined}
        >
          <ElementView element={element} />
          {onSelect && (
            <rect
              width={element.width}
              height={element.height}
              fill="transparent"
              stroke={selected === element.id ? '#0088cc' : 'transparent'}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              className="group-focus-visible:stroke-brand"
            />
          )}
        </g>
      ))}
    </svg>
  )
}

function ElementView({ element }: { element: SlideElement }) {
  const { width, height } = element
  if (element.kind === 'shape') {
    const style = {
      fill: `#${element.fill}`,
      fillOpacity: element.opacity,
      stroke: `#${element.line}`,
      strokeWidth: (element.lineWidth * 4) / 3,
    }
    if (element.shape === 'ellipse')
      return <ellipse cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} {...style} />
    if (element.shape === 'line') return <line x1={0} y1={0} x2={width} y2={height} {...style} />
    return (
      <rect
        width={width}
        height={height}
        rx={element.shape === 'roundRect' ? Math.min(width, height) * 0.12 : 0}
        {...style}
      />
    )
  }
  if (element.kind === 'chart') return <ChartView element={element} />
  const style = {
    color: `#${element.color}`,
    fontFamily: element.fontFace,
    fontSize: (element.fontSize * 4) / 3,
  }
  return (
    <foreignObject width={width} height={height} style={{ overflow: 'hidden' }}>
      {element.kind === 'text' ? (
        <div
          style={{
            ...style,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            lineHeight: 1.2,
            fontWeight: element.bold ? 700 : 400,
            fontStyle: element.italic ? 'italic' : 'normal',
            textAlign: element.align,
          }}
        >
          {element.text}
        </div>
      ) : (
        <table
          style={{
            ...style,
            width: '100%',
            height: '100%',
            tableLayout: 'fixed',
            borderCollapse: 'collapse',
            background: `#${element.fill}`,
          }}
        >
          <tbody>
            {element.rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, col) => (
                  <td
                    key={col}
                    style={{
                      border: `0.667px solid #${element.border}`,
                      padding: '5.333px',
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </foreignObject>
  )
}

function ChartView({ element }: { element: ChartElement }) {
  const { width, height, categories, series, colors } = element
  const left = Math.min(40, width * 0.15)
  const top = Math.min(12, height * 0.1)
  const plotWidth = Math.max(1, width - left - 10)
  const plotHeight = Math.max(1, height - top - (element.showLegend ? 60 : 32))
  const points = series.flatMap((entry) => entry.values)
  const maximum = Math.max(0, ...points)
  const minimum = Math.min(0, ...points)
  const range = maximum - minimum || 1
  const y = (value: number) => top + ((maximum - value) / range) * plotHeight
  const x = (index: number) => left + ((index + 0.5) * plotWidth) / categories.length
  const color = (index: number) => `#${colors[index % colors.length]}`
  let cumulative = 0
  const values = series[0]!.values
  const total = values.reduce((sum, value) => sum + value, 0)
  const radius = Math.max(0.5, Math.min(plotWidth, plotHeight) / 2)
  const centerX = left + plotWidth / 2
  const centerY = top + plotHeight / 2
  return (
    <g style={{ fontFamily: 'sans-serif', fontSize: Math.min(14, height / 10), fill: '#334155' }}>
      {element.chart === 'pie' ? (
        values.map((value, index) => {
          const start = (cumulative / total) * Math.PI * 2 - Math.PI / 2
          cumulative += value
          const end = (cumulative / total) * Math.PI * 2 - Math.PI / 2
          if (value === 0) return null
          if (value === total)
            return <circle key={index} cx={centerX} cy={centerY} r={radius} fill={color(index)} />
          const path = `M ${centerX} ${centerY} L ${centerX + radius * Math.cos(start)} ${centerY + radius * Math.sin(start)} A ${radius} ${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${centerX + radius * Math.cos(end)} ${centerY + radius * Math.sin(end)} Z`
          return <path key={index} d={path} fill={color(index)} />
        })
      ) : (
        <>
          <line x1={left} x2={left + plotWidth} y1={y(0)} y2={y(0)} stroke="#94a3b8" />
          <text x={left - 4} y={top + 12} textAnchor="end">
            {maximum.toLocaleString()}
          </text>
          <text x={left - 4} y={top + plotHeight} textAnchor="end">
            {minimum.toLocaleString()}
          </text>
          {series.map((entry, seriesIndex) =>
            element.chart === 'line' ? (
              <g key={seriesIndex}>
                <polyline
                  points={entry.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
                  fill="none"
                  stroke={color(seriesIndex)}
                  strokeWidth={2}
                />
                {entry.values.map((value, index) => (
                  <circle
                    key={index}
                    cx={x(index)}
                    cy={y(value)}
                    r={2.5}
                    fill={color(seriesIndex)}
                  />
                ))}
              </g>
            ) : (
              entry.values.map((value, index) => {
                const band = (plotWidth / categories.length) * 0.75
                const barWidth = band / series.length
                return (
                  <rect
                    key={`${seriesIndex}-${index}`}
                    x={x(index) - band / 2 + seriesIndex * barWidth}
                    y={Math.min(y(value), y(0))}
                    width={barWidth}
                    height={Math.abs(y(value) - y(0))}
                    fill={color(seriesIndex)}
                  />
                )
              })
            ),
          )}
          {categories.map((label, index) => (
            <text key={index} x={x(index)} y={top + plotHeight + 20} textAnchor="middle">
              {label}
            </text>
          ))}
        </>
      )}
      {element.showLegend &&
        (element.chart === 'pie' ? categories : series.map((entry) => entry.name)).map(
          (label, index, labels) => (
            <g
              key={index}
              transform={`translate(${(index * width) / labels.length + 8} ${height - 14})`}
            >
              <rect width={8} height={8} y={-7} fill={color(index)} />
              <text x={12}>{label}</text>
            </g>
          ),
        )}
    </g>
  )
}

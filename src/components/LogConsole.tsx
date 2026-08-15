import { useEffect, useRef } from 'react'

import { t } from '@/lib/i18n'
import type { LogLine } from '@/lib/ipc'

/**
 * Raw harness output.
 *
 * It follows the tail while the reader is already at the bottom, and stops
 * following the moment they scroll up — so reading an error is not a fight with
 * incoming lines.
 */
export function LogConsole({ lines }: { lines: LogLine[] }) {
  const viewport = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useEffect(() => {
    const element = viewport.current
    if (!element || !following.current) return
    element.scrollTop = element.scrollHeight
  }, [lines])

  const onScroll = () => {
    const element = viewport.current
    if (!element) return
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    following.current = distanceToBottom < 24
  }

  return (
    <section className="overflow-hidden rounded-panel bg-canvas-deep/70 shadow-panel backdrop-blur-xl hairline">
      <h2 className="border-b border-line px-4 py-2 text-[11px] font-medium tracking-[0.08em] text-faint uppercase">
        {t('log.title')}
      </h2>

      <div
        ref={viewport}
        onScroll={onScroll}
        className="selectable max-h-[34vh] min-h-24 overflow-y-auto px-4 py-3 font-mono text-[11.5px] leading-[1.65]"
      >
        {lines.length === 0 ? (
          <p className="text-faint">{t('log.empty')}</p>
        ) : (
          lines.map((entry, index) => (
            <p
              key={index}
              className={
                entry.stream === 'stderr'
                  ? 'break-words whitespace-pre-wrap text-danger'
                  : 'break-words whitespace-pre-wrap text-muted'
              }
            >
              {entry.line}
            </p>
          ))
        )}
      </div>
    </section>
  )
}

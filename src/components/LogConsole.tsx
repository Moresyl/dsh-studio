import { useEffect, useRef } from 'react'
import { TerminalSquare } from 'lucide-react'

import { t } from '@/lib/i18n'
import type { LogLine } from '@/lib/ipc'

/**
 * Raw harness output, as a pane rather than a disclosure.
 *
 * It used to be collapsed behind a "show output" toggle, which is the right
 * call on a web page and the wrong one here: this is a supervisor, the output
 * is the evidence, and a tool that hides its evidence by default sends people
 * to a terminal to find out what it is doing.
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
    <section className="flex min-h-0 flex-1 flex-col bg-canvas-deep">
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="caption">{t('log.title')}</h2>
        {lines.length > 0 && (
          <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">
            {t('log.lines', { count: lines.length })}
          </span>
        )}
      </header>

      <div
        ref={viewport}
        onScroll={onScroll}
        className="selectable min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-[1.65]"
      >
        {lines.length === 0 ? (
          // Centred, because an empty pane's message is the whole content of
          // that pane — left in the corner it reads as the first line of output
          // that never came.
          <div className="flex h-full flex-col items-center justify-center gap-2.5 text-faint">
            <TerminalSquare size={24} strokeWidth={1.4} className="opacity-45" aria-hidden="true" />
            <p className="font-sans text-[12px]">{t('log.empty')}</p>
          </div>
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

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ClipboardCopy,
  Copy,
  Eraser,
  Search,
  TerminalSquare,
  TriangleAlert,
} from 'lucide-react'

import { t } from '@/lib/i18n'
import type { LogLine } from '@/lib/ipc'
import { logTone } from '@/lib/log-tone'
import { runtimeNotices } from '@/lib/runtime-notices'
import { TabButton } from '@/components/TabButton'
import { contextMenu, selectedText } from '@/state/menu'
import { reportAction } from '@/state/failure'

/**
 * Diagnostic output stays available on demand and opens for errors. Recognized
 * plugin failures also have a readable summary outside the disclosure.
 *
 * It follows the tail while the reader is already at the bottom, and stops
 * following the moment they scroll up — so reading an error is not a fight with
 * incoming lines.
 *
 * What people do with a log is paste it somewhere, so the right-click menu is
 * the pane's real interface: copy what is highlighted, copy the lot, or wipe
 * the screen before reproducing something.
 */
export function LogConsole({ lines, onClear }: { lines: LogLine[]; onClear: () => void }) {
  const viewport = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'issues'>('all')
  const issues = useMemo(() => lines.filter((entry) => logTone(entry) !== 'normal'), [lines])
  const errors = useMemo(
    () => issues.filter((entry) => logTone(entry) === 'error').length,
    [issues],
  )
  const notices = useMemo(() => runtimeNotices(lines), [lines])
  const open = expanded ?? errors > 0
  const visible = useMemo(
    () =>
      (filter === 'all' ? lines : issues).filter((entry) =>
        entry.line.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    [filter, lines, issues, query],
  )

  useEffect(() => {
    const element = viewport.current
    if (!element || !following.current) return
    element.scrollTop = element.scrollHeight
  }, [visible, open])

  const onScroll = () => {
    const element = viewport.current
    if (!element) return
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    following.current = distanceToBottom < 24
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-canvas">
      {notices.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-y-auto px-5 pt-4">
          {notices.map((notice) => (
            <div
              key={notice.name}
              className="mb-2 flex items-start gap-3 rounded-xl border border-warn/20 bg-warn/5 px-4 py-3"
            >
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-text [overflow-wrap:anywhere]">
                  {t('log.pluginSkipped', { name: notice.name })}
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted">
                  {t(notice.incompatible ? 'log.pluginIncompatible' : 'log.pluginSkippedHint')}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-line px-5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
          className="flex min-h-10 items-center gap-2 text-[13px] font-medium text-text"
        >
          <ChevronDown size={15} className={open ? '' : '-rotate-90'} aria-hidden="true" />
          {t('log.title')}
        </button>
        <span className="ml-auto text-[12px] tabular-nums text-muted">
          {t('log.lines', { count: lines.length })}
        </span>
        {issues.length > 0 && (
          <span
            className={`rounded-full px-2 py-1 text-[11px] ${errors > 0 ? 'bg-danger/10 text-danger' : 'bg-warn/10 text-warn'}`}
          >
            {t('log.issuesCount', { count: issues.length })}
          </span>
        )}
      </header>
      {!open && (
        <p className="px-5 py-4 text-[13px] leading-relaxed text-muted">{t('log.collapsed')}</p>
      )}
      {open && (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-2">
            <TabButton
              label={t('log.all')}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            <TabButton
              label={t('log.issues')}
              active={filter === 'issues'}
              onClick={() => setFilter('issues')}
            />
            <label className="ml-auto flex min-w-0 items-center gap-2 rounded-lg border border-line px-2">
              <Search size={13} className="text-muted" aria-hidden="true" />
              <input
                type="search"
                aria-label={t('log.search')}
                placeholder={t('log.search')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 min-w-0 bg-transparent text-[12px] text-text outline-none"
              />
            </label>
            <button
              type="button"
              aria-label={t('menu.copyAll')}
              title={t('menu.copyAll')}
              disabled={visible.length === 0}
              onClick={() =>
                void reportAction(() =>
                  navigator.clipboard.writeText(visible.map((entry) => entry.line).join('\n')),
                )
              }
              className="grid size-8 place-items-center rounded-lg text-muted hover:bg-control-fill disabled:opacity-40"
            >
              <Copy size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t('menu.clearLog')}
              title={t('menu.clearLog')}
              disabled={lines.length === 0}
              onClick={onClear}
              className="grid size-8 place-items-center rounded-lg text-muted hover:bg-control-fill disabled:opacity-40"
            >
              <Eraser size={14} aria-hidden="true" />
            </button>
          </div>
          <div
            ref={viewport}
            onScroll={onScroll}
            // Built at the click and not at the render, because whether there is a
            // selection to copy is only true or false at the moment of asking.
            onContextMenu={contextMenu(() => {
              const selection = selectedText()
              return [
                {
                  label: t('menu.copy'),
                  icon: Copy,
                  // Greyed rather than absent, so the menu does not change shape
                  // between one right-click and the next.
                  disabled: selection.length === 0,
                  run: () => void reportAction(() => navigator.clipboard.writeText(selection)),
                },
                {
                  label: t('menu.copyAll'),
                  icon: ClipboardCopy,
                  disabled: lines.length === 0,
                  run: () =>
                    void reportAction(() =>
                      navigator.clipboard.writeText(lines.map((entry) => entry.line).join('\n')),
                    ),
                },
                {
                  label: t('menu.clearLog'),
                  icon: Eraser,
                  disabled: lines.length === 0,
                  run: onClear,
                },
              ]
            })}
            className="selectable min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-[1.65]"
          >
            {visible.length === 0 ? (
              // Centred, because an empty pane's message is the whole content of
              // that pane — left in the corner it reads as the first line of output
              // that never came.
              <div className="flex h-full flex-col items-center justify-center gap-2.5 text-faint">
                <TerminalSquare
                  size={24}
                  strokeWidth={1.4}
                  className="opacity-45"
                  aria-hidden="true"
                />
                <p className="font-sans text-[12px]">
                  {t(lines.length === 0 ? 'log.empty' : 'log.noMatches')}
                </p>
              </div>
            ) : (
              visible.map((entry, index) => <LogRow key={index} entry={entry} />)
            )}
          </div>
        </>
      )}
    </section>
  )
}

/** Existing rows keep their object identity when one line is appended. */
const LogRow = memo(function LogRow({ entry }: { entry: LogLine }) {
  const tone = logTone(entry)
  return (
    <p
      className={[
        'break-words whitespace-pre-wrap',
        tone === 'error' ? 'text-danger' : tone === 'warning' ? 'text-warn' : 'text-muted',
      ].join(' ')}
    >
      {entry.line}
    </p>
  )
})

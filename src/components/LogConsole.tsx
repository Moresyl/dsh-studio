import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  ClipboardCopy,
  Copy,
  Eraser,
  Search,
  TerminalSquare,
  TriangleAlert,
} from 'lucide-react'

import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { Empty } from '@/components/Empty'
import { IconButton } from '@/components/IconButton'
import { Segmented } from '@/components/Segmented'
import { t } from '@/lib/i18n'
import type { LogLine } from '@/lib/ipc'
import { logTone } from '@/lib/log-tone'
import { runtimeNotices } from '@/lib/runtime-notices'
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
 *
 * Above the output are two rows of the same 40px: the title, which is also the
 * disclosure, and — once it is open — a toolbar of controls that are all one
 * size, so the filter, the search and the two buttons read as one strip.
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
    <section data-log-expanded={open} className="flex min-h-0 flex-1 flex-col bg-canvas">
      {notices.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-y-auto px-5 pt-4">
          {notices.map((notice) => (
            <div
              key={notice.name}
              className="mb-2 flex items-start gap-3 rounded-xl border border-warn/20 bg-warn/5 px-4 py-3"
            >
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-ui-base font-medium text-text [overflow-wrap:anywhere]">
                  {t('log.pluginSkipped', { name: notice.name })}
                </p>
                <p className="mt-1 text-ui-sm text-muted">
                  {t(notice.incompatible ? 'log.pluginIncompatible' : 'log.pluginSkippedHint')}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-line px-5">
        <Button
          variant="ghost"
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
          className="-ml-3"
        >
          <ChevronRight
            aria-hidden="true"
            className={`transition-transform duration-150 ease-[var(--ease-out-soft)] ${open ? 'rotate-90' : ''}`}
          />
          <span className="text-text">{t('log.title')}</span>
        </Button>
        <span className="ml-auto text-ui-sm tabular-nums text-faint">
          {open && (filter !== 'all' || query.trim())
            ? t('log.visibleLines', { count: visible.length, total: lines.length })
            : t('log.lines', { count: lines.length })}
        </span>
        {issues.length > 0 && (
          <Badge tone={errors > 0 ? 'danger' : 'warn'}>
            {t('log.issuesCount', { count: issues.length })}
          </Badge>
        )}
      </header>
      {!open && <p className="px-5 py-4 text-ui-sm text-faint">{t('log.collapsed')}</p>}
      {open && (
        <>
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-1">
            <Segmented
              size="sm"
              label={t('log.title')}
              value={filter}
              onChange={setFilter}
              items={[
                { value: 'all', label: t('log.all') },
                { value: 'issues', label: t('log.issues') },
              ]}
            />
            <label className="field-shell field-shell--sm ml-auto w-56 max-w-full">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                aria-label={t('log.search')}
                placeholder={t('log.search')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query !== '') {
                    event.stopPropagation()
                    setQuery('')
                  }
                }}
              />
            </label>
            <IconButton
              icon={Copy}
              label={t('log.copyVisible')}
              disabled={visible.length === 0}
              onClick={() =>
                void reportAction(() =>
                  navigator.clipboard.writeText(visible.map((entry) => entry.line).join('\n')),
                )
              }
            />
            <IconButton
              icon={Eraser}
              label={t('menu.clearLog')}
              disabled={lines.length === 0}
              onClick={onClear}
            />
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
            className="selectable min-h-0 flex-1 overflow-y-auto px-5 py-2"
          >
            {visible.length === 0 ? (
              // Centred, because an empty pane's message is the whole content of
              // that pane — left in the corner it reads as the first line of output
              // that never came.
              <Empty
                icon={TerminalSquare}
                message={t(lines.length === 0 ? 'log.empty' : 'log.noMatches')}
              />
            ) : (
              visible.map((entry, index) => <LogRow key={index} entry={entry} />)
            )}
          </div>
        </>
      )}
    </section>
  )
}

/**
 * Existing rows keep their object identity when one line is appended.
 *
 * The mono face belongs to the row and not to the pane, so the empty state can
 * share the pane in the interface's own face.
 */
const LogRow = memo(function LogRow({ entry }: { entry: LogLine }) {
  const tone = logTone(entry)
  return (
    <p
      className={[
        'font-mono text-ui-sm break-words whitespace-pre-wrap',
        tone === 'error' ? 'text-danger' : tone === 'warning' ? 'text-warn' : 'text-muted',
      ].join(' ')}
    >
      {entry.line}
    </p>
  )
})

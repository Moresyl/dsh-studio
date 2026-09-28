import { useEffect, useRef } from 'react'
import { ClipboardPaste, Copy, Eraser, Plus, SquareTerminal, X } from 'lucide-react'

import { Button } from '@/components/Button'
import { PaneHeader } from '@/components/PaneHeader'
import { SelectControl } from '@/components/SelectControl'
import { StatusDot } from '@/components/StatusDot'
import { t } from '@/lib/i18n'
import * as screens from '@/lib/screen'
import { contextMenu, SEPARATOR } from '@/state/menu'
import { useTerminals, type TerminalTab } from '@/state/terminals'
import { useTerminalLayout, visibleTerminalIds } from '@/state/terminal-layout'

/**
 * Shells, inside the window.
 *
 * The point of it being here rather than in a console the app shells out to is
 * that these processes belong to this application: they are in its job object,
 * so quitting the application ends them, and the pane says so in its empty state
 * rather than leaving it to be discovered.
 *
 * Bounded host elements, and the emulators move through them. The pane can unmount —
 * the user goes to look at the plugin market — and the terminals keep running
 * and keep printing into scrollback that is still there on the way back. That is
 * why nothing in here holds a terminal in React state: this component draws the
 * chrome around one, and `lib/screen` owns the terminal itself.
 */
export function TerminalPane() {
  const tabs = useTerminals((state) => state.tabs)
  const active = useTerminals((state) => state.active)
  const opening = useTerminals((state) => state.opening)
  const error = useTerminals((state) => state.error)
  const open = useTerminals((state) => state.open)
  const close = useTerminals((state) => state.close)
  const select = useTerminals((state) => state.select)
  const dismiss = useTerminals((state) => state.dismiss)
  const layout = useTerminalLayout((state) => state.layout)
  const chooseLayout = useTerminalLayout((state) => state.choose)
  const visible = visibleTerminalIds(
    tabs.map((tab) => tab.id),
    active,
    layout,
  )

  const host = useRef<HTMLDivElement>(null)

  // The emulator is made before the shell, because a shell is told its size once
  // and only the emulator can measure the box it is about to fill.
  const start = () => {
    const box =
      host.current?.querySelector<HTMLElement>(
        '[data-terminal-active="true"] [data-terminal-host]',
      ) ??
      host.current?.querySelector<HTMLElement>('[data-terminal-host]') ??
      host.current
    if (!box || opening) return
    const { screen, rows, cols } = screens.open(box)
    void open(screen, rows, cols)
  }

  const menu = contextMenu(() => {
    // A right click selects its pane before this bubbling handler runs.
    const active = useTerminals.getState().active
    if (!active) return []
    const selection = screens.selection(active)

    return [
      {
        label: t('menu.copy'),
        icon: Copy,
        disabled: selection.length === 0,
        run: () => screens.copy(active),
      },
      { label: t('menu.paste'), icon: ClipboardPaste, run: () => screens.paste(active) },
      SEPARATOR,
      { label: t('terminal.clear'), icon: Eraser, run: () => screens.clear(active) },
      {
        label: t('terminal.close'),
        icon: X,
        danger: true,
        run: () => void close(active),
      },
    ]
  })

  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col">
      <PaneHeader title={t('terminal.title')} subtitle={t('terminal.subtitle')}>
        <SelectControl
          aria-label={t('terminal.layout')}
          value={layout}
          onValueChange={chooseLayout}
        >
          <option value="single">{t('terminal.layout.single')}</option>
          <option value="columns">{t('terminal.layout.columns')}</option>
          <option value="rows">{t('terminal.layout.rows')}</option>
          <option value="grid">{t('terminal.layout.grid')}</option>
        </SelectControl>
        <Button variant="secondary" onClick={start} disabled={opening}>
          <Plus size={13} strokeWidth={2.3} />
          {t('terminal.new')}
        </Button>
      </PaneHeader>

      {tabs.length > 0 && (
        <div className="chrome flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-line">
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              tab={tab}
              active={tab.id === active}
              onSelect={() => select(tab.id)}
              onClose={() => void close(tab.id)}
            />
          ))}
          {active && (
            <div className="sticky right-0 ml-auto flex shrink-0 items-center gap-0.5 border-l border-line bg-[var(--ground-chrome)] px-1.5">
              <button
                type="button"
                data-hint={t('menu.copy')}
                aria-label={t('menu.copy')}
                onClick={() => screens.copy(active)}
                className="grid size-[22px] place-items-center rounded-[4px] text-faint transition-colors hover:bg-surface-2 hover:text-text"
              >
                <Copy size={11} aria-hidden="true" />
              </button>
              <button
                type="button"
                data-hint={t('menu.paste')}
                aria-label={t('menu.paste')}
                onClick={() => screens.paste(active)}
                className="grid size-[22px] place-items-center rounded-[4px] text-faint transition-colors hover:bg-surface-2 hover:text-text"
              >
                <ClipboardPaste size={11} aria-hidden="true" />
              </button>
              <button
                type="button"
                data-hint={t('terminal.clear')}
                aria-label={t('terminal.clear')}
                onClick={() => screens.clear(active)}
                className="grid size-[22px] place-items-center rounded-[4px] text-faint transition-colors hover:bg-surface-2 hover:text-text"
              >
                <Eraser size={11} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 border-b border-danger/25 bg-danger/10 px-4 py-2 text-left text-[12px] leading-relaxed text-danger"
        >
          {error}
        </button>
      )}

      {/* Positioned, because the emulators inside it are: switching tabs moves
          one out and another in, and for the frame in between the host holds
          both. */}
      <div
        ref={host}
        onContextMenu={menu}
        className={[
          'relative grid min-h-0 min-w-0 flex-1 gap-px overflow-hidden bg-line',
          visible.length > 1 && layout === 'columns' ? 'grid-cols-2 grid-rows-1' : '',
          visible.length > 1 && layout === 'rows' ? 'grid-cols-1 grid-rows-2' : '',
          visible.length > 1 && layout === 'grid'
            ? visible.length > 2
              ? 'grid-cols-2 grid-rows-2'
              : 'grid-cols-2 grid-rows-1'
            : '',
        ].join(' ')}
      >
        {visible.map((id) => {
          const tab = tabs.find((candidate) => candidate.id === id)
          return tab ? (
            <TerminalSurface
              key={id}
              tab={tab}
              active={id === active}
              split={visible.length > 1}
              onSelect={() => select(id)}
            />
          ) : null
        })}
        {tabs.length === 0 && <Empty onStart={start} busy={opening} />}
      </div>
    </section>
  )
}

/** Each emulator keeps its own resize lifecycle; changing layout never respawns it. */
function TerminalSurface({
  tab,
  active,
  split,
  onSelect,
}: {
  tab: TerminalTab
  active: boolean
  split: boolean
  onSelect: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = host.current
    if (!box) return
    if (screens.has(tab.id)) screens.attach(tab.id, box, false)
    else screens.restore(tab.id, box)
    const observer = new ResizeObserver(() => screens.measure(tab.id))
    observer.observe(box)
    return () => {
      observer.disconnect()
      screens.detach(tab.id)
    }
  }, [tab.id])

  useEffect(() => {
    if (active) screens.focus(tab.id)
  }, [active, tab.id])

  return (
    <div
      data-terminal-active={active}
      data-terminal-id={tab.id}
      onFocusCapture={onSelect}
      onPointerDown={onSelect}
      onContextMenu={onSelect}
      className="flex min-h-0 min-w-0 flex-col bg-canvas-deep"
    >
      {split && (
        <button
          type="button"
          onClick={() => {
            onSelect()
            screens.focus(tab.id)
          }}
          aria-pressed={active}
          title={tab.cwd}
          className={`flex h-8 shrink-0 items-center gap-2 truncate border-b px-3 text-left text-[11px] ${active ? 'border-brand/40 bg-brand/8 text-text' : 'border-line text-faint'}`}
        >
          <SquareTerminal size={12} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            {tab.label} · {tab.cwd}
          </span>
        </button>
      )}
      <div ref={host} data-terminal-host className="relative min-h-0 min-w-0 flex-1" />
    </div>
  )
}

interface TabProps {
  tab: TerminalTab
  active: boolean
  onSelect: () => void
  onClose: () => void
}

/**
 * One shell's tab: what it is, whether it is still running, and the way out.
 *
 * The close control is on the active tab always and on the others under the
 * pointer, which is the rule every tab strip a user has already met follows.
 */
function Tab({ tab, active, onSelect, onClose }: TabProps) {
  const finished = tab.exit !== null

  return (
    <div
      className={[
        'group relative flex h-full shrink-0 items-center border-r border-line/70 transition-colors duration-100',
        active ? 'bg-canvas-deep' : 'hover:bg-surface-2/50',
      ].join(' ')}
    >
      {/* On the strip's own edge, matching how the nav rail marks its place. */}
      {active && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[2px] rounded-b-full bg-brand"
        />
      )}

      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        data-terminal-tab={tab.id}
        data-hint={tab.cwd}
        onClick={onSelect}
        className={[
          'flex h-full min-w-0 items-center gap-2 pr-1.5 pl-3 text-[11.5px]',
          active ? 'text-text' : 'text-faint group-hover:text-muted',
        ].join(' ')}
      >
        <StatusDot
          tone={{
            color: finished ? 'var(--color-danger)' : 'var(--color-ok)',
            live: false,
          }}
          size={5}
        />
        <span className="max-w-[132px] truncate font-mono">{tab.label}</span>
      </button>

      <button
        type="button"
        onClick={onClose}
        aria-label={t('terminal.close')}
        className={[
          'mr-1.5 grid size-[18px] shrink-0 place-items-center rounded-[4px] transition duration-100',
          'text-faint/70 hover:bg-surface-2 hover:text-text',
          active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        ].join(' ')}
      >
        <X size={11} strokeWidth={2.4} aria-hidden="true" />
      </button>
    </div>
  )
}

/**
 * Nothing open yet.
 *
 * A shell is not started for someone who only clicked the rail icon: this app
 * runs a harness that can itself run commands, and a pane that spawns a process
 * on arrival would be the wrong habit for it to have. So the first one is asked
 * for, and the empty state is where the offer is made.
 */
function Empty({ onStart, busy }: { onStart: () => void; busy: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center px-6">
      <div className="flex max-w-[380px] flex-col items-center gap-3 text-center">
        <SquareTerminal size={26} strokeWidth={1.5} className="text-faint" aria-hidden="true" />
        <p className="text-[12.5px] text-muted">{t('terminal.empty')}</p>
        <p className="text-[11.5px] leading-relaxed text-faint">{t('terminal.emptyHint')}</p>
        <Button variant="primary" className="mt-1" onClick={onStart} disabled={busy}>
          <Plus size={13} strokeWidth={2.3} />
          {t('terminal.new')}
        </Button>
      </div>
    </div>
  )
}

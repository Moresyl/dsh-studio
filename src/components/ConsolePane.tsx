import { useState, type ReactNode } from 'react'
import { ChevronRight, Copy, ExternalLink, Loader2, RotateCw, Square, Terminal } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'

import { Ambient } from '@/components/Ambient'
import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/Button'
import { EnvironmentChecks, EnvironmentProgress } from '@/components/Environment'
import { LogConsole } from '@/components/LogConsole'
import { PresetPicker } from '@/components/PresetPicker'
import { StatusDot } from '@/components/StatusDot'
import { t } from '@/lib/i18n'
import { formatVersion, isAtLeast, type NodeInstallation, type NodeVersion } from '@/lib/ipc'
import { labelOf, toneOf } from '@/lib/status'
import { useHarness } from '@/state/harness'
import { contextMenu } from '@/state/menu'

/**
 * The console: the state of the machine, and the harness's own output.
 *
 * Two regions, not one centred column. A rail on the left holds what the
 * machine has and the one button that changes it; the rest of the pane is the
 * output of the thing being supervised. That is the shape of a tool that
 * supervises something — controls on one side, the thing being controlled on
 * the other — and it is the reason the window looks occupied at 1360px instead
 * of holding a small card in the middle of a lot of nothing.
 *
 * Inside the rail the sections run static-first — what the machine has, then
 * what it will run as — so that a section appearing pushes nothing that was
 * already being read. Everything that is a diagnostic rather than a decision is
 * behind one fold, closed until it is asked for: the runtimes this chose between
 * and the address it ended up on are worth having, and neither is worth the room
 * it takes on a rail somebody is reading for the first time. The action sits on
 * the bottom edge whatever is above it, which is where a pane's primary button
 * belongs and what turns the leftover height into margin instead of a hole.
 */
export function ConsolePane() {
  const {
    environment,
    status,
    lines,
    busy,
    installing,
    provisioningNode,
    selectNode,
    error,
    inspect,
    start,
    stop,
    clear,
  } = useHarness()

  const runnable =
    environment !== null &&
    environment.node !== null &&
    environment.harnessInstalled &&
    environment.harnessCompatible &&
    environment.workspaceAdmission.state !== 'blocked'
  const working = installing || provisioningNode
  const starting = busy || status.phase === 'starting' || status.phase === 'restarting'
  const running = status.phase === 'ready'
  const runtimes = environment?.allNodeRuntimes ?? []

  return (
    <div className="flex min-h-0 flex-1 animate-rise">
      <aside className="chrome relative flex w-[340px] shrink-0 flex-col border-r border-line">
        <Ambient />

        <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
          <div className="flex items-center gap-3">
            <BrandMark size={38} className="rounded-[9px] shadow-lift" />
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-[15px] leading-none font-semibold tracking-[-0.01em] text-text">
                DSH Studio
              </h1>
              <p className="flex items-center gap-1.5 text-[12px] leading-none text-muted">
                <StatusDot tone={toneOf(status)} size={6} />
                {labelOf(status)}
              </p>
            </div>
          </div>

          <Section
            title={t('section.environment')}
            action={
              <Button
                variant="ghost"
                className="h-5 px-1.5 text-[11.5px]"
                // The store already puts the reason beside this control; catch
                // here so a manual failed probe is not also an unhandled browser
                // promise rejection.
                onClick={() => void inspect().catch(() => {})}
                disabled={working}
              >
                <RotateCw size={11} strokeWidth={2.4} />
                {t('action.recheck')}
              </Button>
            }
          >
            <EnvironmentChecks />
          </Section>

          {/* A decision and not a diagnostic, so it stays out on the rail: the
              guide asks it once on a first run, and this is where it is asked
              again afterwards. */}
          <Section title={t('section.agent')}>
            <PresetPicker />
          </Section>

          {/* Nothing in here is needed to use the app, and both of them only
              exist some of the time — one runtime installed makes the list a
              repeat of the check above it, and there is no address until
              something is serving. A fold that is empty is not offered at all. */}
          {(runtimes.length > 1 || running) && (
            <Advanced>
              {runtimes.length > 1 && environment && (
                <Section title={t('section.runtimes')}>
                  <RuntimeList
                    runtimes={runtimes}
                    activePath={environment.node?.path ?? null}
                    minimum={environment.minimumNode}
                    disabled={running || starting || working}
                    onSelect={(path) => void selectNode(path)}
                  />
                </Section>
              )}

              {status.phase === 'ready' && (
                <Section title={t('section.service')}>
                  <ServiceFacts origin={status.origin} pid={status.pid} />
                </Section>
              )}
            </Advanced>
          )}

          <EnvironmentProgress />

          <div className="mt-auto flex flex-col gap-2">
            {running ? (
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => void stop()}
                disabled={busy}
              >
                <Square size={13} strokeWidth={2.6} />
                {t('action.stop')}
              </Button>
            ) : (
              <Button
                variant="primary"
                className="w-full"
                onClick={() => void start()}
                disabled={!runnable || starting || working}
              >
                {starting ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {t('action.starting')}
                  </>
                ) : (
                  <>
                    <Terminal size={14} strokeWidth={2.3} />
                    {status.phase === 'failed' ? t('action.retry') : t('action.start')}
                  </>
                )}
              </Button>
            )}

            {error && (
              <p className="selectable max-h-36 min-w-0 overflow-y-auto rounded-control border border-danger/30 bg-danger/10 px-2.5 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-danger [overflow-wrap:anywhere]">
                {error}
              </p>
            )}
          </div>
        </div>
      </aside>

      <LogConsole lines={lines} onClear={clear} />
    </div>
  )
}

/** A titled group in the rail: tracked-out caption, optional trailing control. */
function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex h-5 items-center">
        <h2 className="caption">{title}</h2>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * The fold the diagnostics live behind.
 *
 * Closed to begin with, and the point of it is what it replaces: not a second
 * mode with a switch somewhere else, but one row on the rail that says there is
 * more and opens it where it stands. Whoever wants the address or the runtime
 * list is one click from it and can see, before clicking, that it is there.
 *
 * Open is remembered for as long as the window is, and no longer. Someone who
 * opened it to read a port number has not asked for it open every morning.
 */
function Advanced({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex h-5 cursor-pointer items-center gap-1 text-left"
      >
        <ChevronRight
          size={12}
          strokeWidth={2.6}
          aria-hidden="true"
          className={`shrink-0 text-faint transition-transform duration-150 ease-[var(--ease-out-soft)] group-hover:text-muted ${open ? 'rotate-90' : ''}`}
        />
        <span className="caption transition-colors group-hover:text-muted">
          {t('section.advanced')}
        </span>
      </button>

      {/* Unmounted rather than hidden. There is nothing in here holding state
          worth keeping — both children read what they show from the store. */}
      {open && <div className="flex animate-rise flex-col gap-4">{children}</div>}
    </section>
  )
}

/**
 * The live service, in the two facts anyone asks for.
 *
 * This is the only place the address appears, and the right one: it is a fact
 * about the plumbing, and this is the panel where the plumbing is. A click opens
 * it in the user's own browser — the harness is a web service and sometimes the
 * right window for it is not this one — and a right-click offers to copy it,
 * because the other half of the time it is being pasted into a terminal. The
 * process id is what you need when the answer is to go and look at the thing in
 * a task manager, so it copies too.
 */
function ServiceFacts({ origin, pid }: { origin: string; pid: number }) {
  const [copied, setCopied] = useState(false)

  // The webview's own clipboard rather than a plugin: this document is served
  // from localhost, a secure context on every platform we ship, and a click is
  // the user gesture the API asks for.
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <dl className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-canvas-deep/50">
      <div className="flex h-[30px] items-center gap-2 px-2.5">
        <dt className="shrink-0 text-[12px] text-muted">{t('service.address')}</dt>
        <dd className="ml-auto min-w-0">
          <button
            type="button"
            data-hint={t('statusbar.open')}
            onClick={() => void openUrl(origin)}
            onContextMenu={contextMenu([
              {
                label: t('statusbar.open'),
                icon: ExternalLink,
                run: () => void openUrl(origin),
              },
              {
                label: t('menu.copyAddress'),
                icon: Copy,
                run: () => copy(origin),
              },
            ])}
            className="flex items-center gap-1.5 font-mono text-[11.5px] text-text tabular-nums transition-colors duration-100 hover:text-brand"
          >
            <span className="truncate">
              {copied ? t('statusbar.copied') : origin.replace(/^https?:\/\//, '')}
            </span>
            <ExternalLink size={11} strokeWidth={2.2} className="shrink-0 text-faint" />
          </button>
        </dd>
      </div>

      <div className="flex h-[30px] items-center gap-2 px-2.5">
        <dt className="shrink-0 text-[12px] text-muted">{t('service.process')}</dt>
        <dd
          onContextMenu={contextMenu([
            { label: t('menu.copyPid'), icon: Copy, run: () => copy(String(pid)) },
          ])}
          className="ml-auto font-mono text-[11.5px] text-text tabular-nums"
        >
          {pid}
        </dd>
      </div>
    </dl>
  )
}

/**
 * Every Node the backend found, newest first, with the one it picked marked.
 *
 * The choice is otherwise invisible: a machine with four runtimes reports a
 * single version in the check row above and gives no hint that it was a
 * selection at all. When that version is not the one someone expected, this is
 * the list that answers why.
 */
function RuntimeList({
  runtimes,
  activePath,
  minimum,
  disabled,
  onSelect,
}: {
  runtimes: NodeInstallation[]
  activePath: string | null
  minimum: NodeVersion
  disabled: boolean
  onSelect: (path: string) => void
}) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-canvas-deep/50">
      {runtimes.map((runtime) => {
        const active = runtime.path === activePath
        const usable = isAtLeast(runtime.version, minimum)

        return (
          <li
            key={runtime.path}
            data-hint={runtime.path}
            className="flex h-[30px] items-center gap-2 px-2.5"
          >
            <button
              type="button"
              disabled={disabled || !usable || active}
              aria-pressed={active}
              title={runtime.path}
              onClick={() => onSelect(runtime.path)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
            >
              <span
                className={`shrink-0 font-mono text-[11.5px] tabular-nums ${usable ? 'text-text' : 'text-faint'}`}
              >
                {formatVersion(runtime.version)}
              </span>
              <span className="truncate text-[11.5px] text-faint">
                {t(`source.${runtime.source}`)}
              </span>
            </button>

            {active ? (
              <span className="ml-auto shrink-0 rounded-[4px] bg-ok/15 px-1.5 py-0.5 text-[10.5px] font-medium text-ok">
                {t('runtime.active')}
              </span>
            ) : (
              !usable && (
                <span className="ml-auto shrink-0 text-[11px] text-faint">
                  {t('runtime.tooOld')}
                </span>
              )
            )}
          </li>
        )
      })}
    </ul>
  )
}

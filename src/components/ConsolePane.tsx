import { useState, type ReactNode } from 'react'
import { ChevronRight, Copy, ExternalLink, Loader2, RotateCw, Square, Terminal } from 'lucide-react'

import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { EnvironmentChecks, EnvironmentProgress } from '@/components/Environment'
import { LogConsole } from '@/components/LogConsole'
import { PresetPicker } from '@/components/PresetPicker'
import { StatusDot } from '@/components/StatusDot'
import { t } from '@/lib/i18n'
import { openExternalUrl } from '@/lib/external-url'
import { formatVersion, isAtLeast, type NodeInstallation, type NodeVersion } from '@/lib/ipc'
import { labelOf, toneOf } from '@/lib/status'
import { useHarness } from '@/state/harness'
import { reportAction } from '@/state/failure'
import { contextMenu } from '@/state/menu'

/**
 * The console: the state of the machine, and the harness's own output.
 *
 * Runtime state and decisions stay above the output. This gives the log the
 * full reading width while the shared sidebar owns navigation for every pane.
 */
export function ConsolePane() {
  return (
    <div className="group/console flex min-h-0 flex-1 flex-col animate-rise">
      <ConsoleRail />
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 has-[[data-log-expanded=false]]:max-h-[50%] has-[[data-log-expanded=false]]:flex-none">
        <HarnessLog />
      </div>
    </div>
  )
}

/**
 * Runtime controls are isolated from the hot log subscription. A busy harness
 * can emit hundreds of lines per second; none of them changes this section, so it
 * should not rebuild the environment cards and menus for every line.
 */
function ConsoleRail() {
  const environment = useHarness((state) => state.environment)
  const status = useHarness((state) => state.status)
  const busy = useHarness((state) => state.busy)
  const installing = useHarness((state) => state.installing)
  const provisioningNode = useHarness((state) => state.provisioningNode)
  const selectNode = useHarness((state) => state.selectNode)
  const error = useHarness((state) => state.error)
  const inspect = useHarness((state) => state.inspect)
  const start = useHarness((state) => state.start)
  const stop = useHarness((state) => state.stop)

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
    <section className="@container max-h-[55%] shrink-0 overflow-y-auto border-b border-line bg-canvas group-has-[[data-log-expanded=false]]/console:max-h-none group-has-[[data-log-expanded=false]]/console:flex-1 group-has-[[data-log-expanded=false]]/console:shrink">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-7 pt-6 pb-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-ui-xl font-semibold text-text">{t('nav.console')}</h1>
            <p className="mt-1 flex items-center gap-2 text-ui-base text-muted">
              <StatusDot tone={toneOf(status)} size={6} />
              {labelOf(status)}
            </p>
          </div>
          {running ? (
            <Button variant="secondary" onClick={() => void stop()} disabled={busy}>
              <Square />
              {t('action.stop')}
            </Button>
          ) : (
            <Button onClick={() => void start()} disabled={!runnable || starting || working}>
              {starting ? <Loader2 className="animate-spin" /> : <Terminal />}
              {starting
                ? t('action.starting')
                : status.phase === 'failed'
                  ? t('action.retry')
                  : t('action.start')}
            </Button>
          )}
        </div>

        <div className="grid gap-5 @min-[900px]:grid-cols-2">
          <Section
            title={t('section.environment')}
            action={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void inspect().catch(() => {})}
                disabled={working}
              >
                <RotateCw />
                {t('action.recheck')}
              </Button>
            }
          >
            <EnvironmentChecks />
          </Section>
          <Section title={t('section.agent')}>
            <PresetPicker />
          </Section>
        </div>

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

        {error && (
          <p className="selectable max-h-36 overflow-y-auto rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm whitespace-pre-wrap text-danger [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
      </div>
    </section>
  )
}

/** The only component that redraws when a new process line arrives. */
function HarnessLog() {
  const lines = useHarness((state) => state.lines)
  const clear = useHarness((state) => state.clear)
  return <LogConsole lines={lines} onClear={clear} />
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
      <div className="flex min-h-7 items-center">
        <h2 className="caption">{title}</h2>
        {action && <div className="-mr-2 ml-auto">{action}</div>}
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
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="-ml-2 self-start"
      >
        <ChevronRight
          aria-hidden="true"
          className={`transition-transform duration-150 ease-[var(--ease-out-soft)] ${open ? 'rotate-90' : ''}`}
        />
        {t('section.advanced')}
      </Button>

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
    void reportAction(async () => {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <dl className="list-card">
      <div className="list-row">
        <dt className="shrink-0 text-ui-base text-muted">{t('service.address')}</dt>
        <dd className="ml-auto min-w-0">
          <button
            type="button"
            data-hint={t('statusbar.open')}
            onClick={() => void reportAction(() => openExternalUrl(origin))}
            onContextMenu={contextMenu([
              {
                label: t('statusbar.open'),
                icon: ExternalLink,
                run: () => void reportAction(() => openExternalUrl(origin)),
              },
              {
                label: t('menu.copyAddress'),
                icon: Copy,
                run: () => copy(origin),
              },
            ])}
            className="flex items-center gap-2 font-mono text-ui-sm text-text tabular-nums transition-colors duration-100 hover:text-brand"
          >
            <span className="truncate">
              {copied ? t('statusbar.copied') : new URL(origin).host}
            </span>
            <ExternalLink size={14} strokeWidth={2} className="shrink-0 text-faint" />
          </button>
        </dd>
      </div>

      <div className="list-row">
        <dt className="shrink-0 text-ui-base text-muted">{t('service.process')}</dt>
        <dd
          onContextMenu={contextMenu([
            { label: t('menu.copyPid'), icon: Copy, run: () => copy(String(pid)) },
          ])}
          className="ml-auto font-mono text-ui-sm text-text tabular-nums"
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
    <ul className="list-card">
      {runtimes.map((runtime) => {
        const active = runtime.path === activePath
        const usable = isAtLeast(runtime.version, minimum)

        return (
          <li key={runtime.path} data-hint={runtime.path} className="list-row">
            <button
              type="button"
              disabled={disabled || !usable || active}
              aria-pressed={active}
              title={runtime.path}
              onClick={() => onSelect(runtime.path)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
            >
              <span
                className={`shrink-0 font-mono text-ui-sm tabular-nums ${usable ? 'text-text' : 'text-faint'}`}
              >
                {formatVersion(runtime.version)}
              </span>
              <span className="truncate text-ui-sm text-faint">
                {t(`source.${runtime.source}`)}
              </span>
            </button>

            {active ? (
              <Badge tone="ok" className="ml-auto">
                {t('runtime.active')}
              </Badge>
            ) : (
              !usable && (
                <span className="ml-auto shrink-0 text-ui-sm text-faint">
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

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  RotateCw,
  Square,
  Terminal,
} from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'

import { Ambient } from '@/components/Ambient'
import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/Button'
import { CheckList, type CheckItem } from '@/components/CheckList'
import { LogConsole } from '@/components/LogConsole'
import { StatusDot } from '@/components/StatusDot'
import { megabytes } from '@/lib/format'
import { t } from '@/lib/i18n'
import {
  formatVersion,
  isAtLeast,
  type Environment,
  type NodeInstallation,
  type NodeProgress,
} from '@/lib/ipc'
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
 * Inside the rail the sections run static-first — environment, then the
 * runtimes it chose between, then the service once there is one — so that a
 * section appearing pushes nothing that was already being read. The action sits
 * on the bottom edge whatever is above it, which is where a pane's primary
 * button belongs and what turns the leftover height into margin instead of a
 * hole.
 */
export function ConsolePane() {
  const {
    environment,
    status,
    lines,
    busy,
    installing,
    installProgress,
    provisioningNode,
    nodeProgress,
    error,
    inspect,
    start,
    stop,
    install,
    provisionNode,
    clear,
  } = useHarness()

  useEffect(() => {
    void inspect()
  }, [inspect])

  const checks = useMemo(
    () => buildChecks({ environment, installing, install, provisioningNode, provisionNode }),
    [environment, installing, install, provisioningNode, provisionNode],
  )
  const runnable = environment !== null && environment.node !== null && environment.harnessInstalled
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
                onClick={() => void inspect()}
                disabled={working}
              >
                <RotateCw size={11} strokeWidth={2.4} />
                {t('action.recheck')}
              </Button>
            }
          >
            <CheckList items={checks} />
          </Section>

          {/* Only worth a section when there was a choice to make. With one
              runtime installed the check row above has already said everything
              this list would repeat. */}
          {runtimes.length > 1 && environment && (
            <Section title={t('section.runtimes')}>
              <RuntimeList
                runtimes={runtimes}
                activePath={environment.node?.path ?? null}
                minimum={environment.minimumNode}
              />
            </Section>
          )}

          {status.phase === 'ready' && (
            <Section title={t('section.service')}>
              <ServiceFacts origin={status.origin} pid={status.pid} />
            </Section>
          )}

          {provisioningNode && <NodeInstallProgress progress={nodeProgress} />}

          {installing && <InstallProgress packages={installProgress} />}

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
              <p className="selectable rounded-control border border-danger/30 bg-danger/10 px-2.5 py-2 text-[12px] leading-relaxed text-danger">
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
}: {
  runtimes: NodeInstallation[]
  activePath: string | null
  minimum: Environment['minimumNode']
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
            <span
              className={`shrink-0 font-mono text-[11.5px] tabular-nums ${usable ? 'text-text' : 'text-faint'}`}
            >
              {formatVersion(runtime.version)}
            </span>
            <span className="truncate text-[11.5px] text-faint">
              {t(`source.${runtime.source}`)}
            </span>

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

/**
 * What an install has done so far.
 *
 * A first install is several minutes of npm, and minutes of an unmoving spinner
 * is where people decide the app is broken. There is no percentage to show —
 * npm does not know a total until it finishes — so this shows the one true
 * thing available, a count that climbs, and says plainly that it will be a
 * while rather than letting someone guess.
 */
function InstallProgress({ packages }: { packages: number }) {
  return (
    <div className="rounded-panel border border-line bg-canvas-deep/50 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Loader2 size={13} className="shrink-0 animate-spin text-brand" />
        <span className="text-[12.5px] text-text">{t('install.working')}</span>
        {packages > 0 && (
          <span className="ml-auto font-mono text-[11.5px] tabular-nums text-muted">
            {t('install.progress', { count: packages })}
          </span>
        )}
      </div>
      <p className="mt-1.5 pl-[21px] text-[11.5px] text-faint">{t('install.slow')}</p>
    </div>
  )
}

/**
 * What the Node install is doing, and how much of it is left.
 *
 * A download has a real total, unlike npm, so this is the one place in the pane
 * that earns a bar with a percentage in it. The line above the bar matters just
 * as much: resolving, verifying and unpacking have no bytes to count, and
 * without a name they are indistinguishable from a bar that has stopped.
 *
 * The note underneath is there for every run, not just the first. Software that
 * downloads a language runtime on someone's behalf should say where it put it
 * before it is asked.
 */
function NodeInstallProgress({ progress }: { progress: NodeProgress | null }) {
  const done = progress?.phase === 'installed'
  const bytes = progress?.phase === 'downloading' ? progress : null
  const fraction = bytes && bytes.total ? Math.min(bytes.received / bytes.total, 1) : null

  return (
    <div className="rounded-panel border border-line bg-canvas-deep/50 px-3 py-2.5">
      <div className="flex items-center gap-2">
        {done ? (
          <Check size={13} strokeWidth={2.6} className="shrink-0 text-ok" aria-hidden="true" />
        ) : (
          <Loader2 size={13} className="shrink-0 animate-spin text-brand" aria-hidden="true" />
        )}
        <span className="truncate text-[12.5px] text-text">{phaseText(progress)}</span>
        {bytes && (
          <span className="ml-auto shrink-0 font-mono text-[11.5px] text-muted tabular-nums">
            {bytes.total
              ? `${megabytes(bytes.received)} / ${megabytes(bytes.total)}`
              : megabytes(bytes.received)}
          </span>
        )}
      </div>

      <div
        className="mt-2 ml-[21px] h-[3px] overflow-hidden rounded-full bg-line-strong"
        role="progressbar"
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      >
        <div
          className={
            fraction === null
              ? 'h-full w-1/4 animate-drift rounded-full bg-brand'
              : 'h-full rounded-full bg-brand transition-[width] duration-200 ease-[var(--ease-out-soft)]'
          }
          style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
        />
      </div>

      <p className="mt-1.5 ml-[21px] text-[11.5px] text-faint">{t('node.explain')}</p>
    </div>
  )
}

/** The phase, said in words, with the release it is about. */
function phaseText(progress: NodeProgress | null): string {
  switch (progress?.phase) {
    // One line for both: a release has been settled on and its bytes are what
    // happens next, which is the same sentence either way.
    case 'chosen':
    case 'downloading':
      return t('node.downloading', { version: progress.version })
    case 'verifying':
      return t('node.verifying')
    case 'extracting':
      return t('node.extracting', { version: progress.version })
    case 'installed':
      return t('node.installed', { version: progress.version })
    // `resolving`, and the moment before the first report arrives.
    default:
      return t('node.resolving')
  }
}

/** The report, plus the two fixes the rows are allowed to offer. */
interface CheckContext {
  environment: Environment | null
  installing: boolean
  install: () => Promise<void>
  provisioningNode: boolean
  provisionNode: () => Promise<void>
}

/**
 * Turn the environment report into the rows the list shows.
 *
 * Only things that can be wrong. The workspace is neither a check nor something
 * anyone acts on from here, so it reports itself from the status bar instead.
 */
function buildChecks({
  environment,
  installing,
  install,
  provisioningNode,
  provisionNode,
}: CheckContext): CheckItem[] {
  const node = environment?.node ?? null
  const minimum = environment ? formatVersion(environment.minimumNode) : ''
  const harnessInstalled = environment?.harnessInstalled ?? false

  return [
    {
      key: 'node',
      label: t('check.node'),
      value: node
        ? t('check.node.found', {
            version: formatVersion(node.version),
            source: t(`source.${node.source}`),
          })
        : t('check.node.missing', { minimum }),
      title: node?.path,
      state: environment === null ? 'neutral' : node ? 'ok' : 'missing',
      // The row that says something is missing carries the thing that fixes it,
      // and for Node that is a runtime this app fetches into its own directory —
      // not a link to a download page and a second installer to get through.
      action:
        environment !== null && node === null
          ? {
              label: provisioningNode ? t('action.installing') : t('action.getNode'),
              icon: Download,
              busy: provisioningNode,
              run: () => void provisionNode(),
            }
          : undefined,
    },
    {
      key: 'harness',
      label: t('check.harness'),
      value: harnessInstalled ? t('check.harness.installed') : t('check.harness.missing'),
      title: environment?.harnessEntry,
      state: environment === null ? 'neutral' : harnessInstalled ? 'ok' : 'missing',
      action:
        environment !== null && !harnessInstalled && node !== null
          ? {
              label: installing ? t('action.installing') : t('action.install'),
              icon: Download,
              busy: installing,
              run: () => void install(),
            }
          : undefined,
    },
  ]
}

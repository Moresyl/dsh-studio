import { useEffect, useMemo, type ReactNode } from 'react'
import { Download, ExternalLink, Loader2, RotateCw, Square, Terminal } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'

import { Ambient } from '@/components/Ambient'
import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/Button'
import { CheckList, type CheckItem } from '@/components/CheckList'
import { LogConsole } from '@/components/LogConsole'
import { StatusDot } from '@/components/StatusDot'
import { t } from '@/lib/i18n'
import { formatVersion, isAtLeast, type Environment, type NodeInstallation } from '@/lib/ipc'
import { labelOf, toneOf } from '@/lib/status'
import { useHarness } from '@/state/harness'

/** Where someone without Node goes to get one. */
const NODE_DOWNLOADS = 'https://nodejs.org/en/download'

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
    error,
    inspect,
    start,
    stop,
    install,
  } = useHarness()

  useEffect(() => {
    void inspect()
  }, [inspect])

  const checks = useMemo(
    () => buildChecks(environment, installing, install),
    [environment, installing, install],
  )
  const runnable = environment !== null && environment.node !== null && environment.harnessInstalled
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
                disabled={installing}
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
                disabled={!runnable || starting || installing}
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

      <LogConsole lines={lines} />
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
 * The address is also in the status bar, and deliberately so — the bar is what
 * you glance at, this is where you are already looking when you are deciding
 * whether to stop it. The process id is here only: it is what you need when the
 * answer is to go and look at the thing in a task manager, and there is no room
 * for it in a status bar that must stay legible at a glance.
 */
function ServiceFacts({ origin, pid }: { origin: string; pid: number }) {
  return (
    <dl className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-canvas-deep/50">
      <div className="flex h-[30px] items-center gap-2 px-2.5">
        <dt className="shrink-0 text-[12px] text-muted">{t('service.address')}</dt>
        <dd className="ml-auto min-w-0">
          <button
            type="button"
            title={t('statusbar.open')}
            onClick={() => void openUrl(origin)}
            className="flex items-center gap-1.5 font-mono text-[11.5px] text-text tabular-nums transition-colors duration-100 hover:text-brand"
          >
            <span className="truncate">{origin.replace(/^https?:\/\//, '')}</span>
            <ExternalLink size={11} strokeWidth={2.2} className="shrink-0 text-faint" />
          </button>
        </dd>
      </div>

      <div className="flex h-[30px] items-center gap-2 px-2.5">
        <dt className="shrink-0 text-[12px] text-muted">{t('service.process')}</dt>
        <dd className="ml-auto font-mono text-[11.5px] text-text tabular-nums">{pid}</dd>
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
            title={runtime.path}
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
 * Turn the environment report into the rows the list shows.
 *
 * Only things that can be wrong. The workspace is neither a check nor something
 * anyone acts on from here, so it reports itself from the status bar instead.
 */
function buildChecks(
  environment: Environment | null,
  installing: boolean,
  install: () => Promise<void>,
): CheckItem[] {
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
      // Node is a system runtime, not something this shell should install
      // behind someone's back — so the offer is to take them to it.
      action:
        environment !== null && node === null
          ? {
              label: t('action.getNode'),
              icon: ExternalLink,
              run: () => void openUrl(NODE_DOWNLOADS),
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

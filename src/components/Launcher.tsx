import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  Hexagon,
  Loader2,
  Square,
  Terminal,
} from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'

import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/Button'
import { CheckList, type CheckItem } from '@/components/CheckList'
import { LogConsole } from '@/components/LogConsole'
import { StatusPill } from '@/components/StatusPill'
import { t } from '@/lib/i18n'
import { formatVersion, type Environment } from '@/lib/ipc'
import { useHarness } from '@/state/harness'

/** Where someone without Node goes to get one. */
const NODE_DOWNLOADS = 'https://nodejs.org/en/download'

/**
 * The screen shown before the harness is serving anything.
 *
 * It answers three questions in order — can this machine run it, is it running,
 * and if not, why — because that is the sequence someone actually asks. Where
 * the answer is "something is missing", the fix is on the same row.
 */
export function Launcher() {
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
  // `null` means the user has not expressed one, so the shell decides.
  const [logPreference, setLogPreference] = useState<boolean | null>(null)

  useEffect(() => {
    void inspect()
  }, [inspect])

  // npm output is the only sign an install is progressing, and a failure is
  // worth reading — either way, do not make them go looking for it. Deciding
  // this by derivation rather than by an effect writing state keeps one opinion
  // in charge: the moment the user opens or closes the panel themselves, theirs
  // wins and stops being overridden.
  const showLog = logPreference ?? (installing || status.phase === 'failed' || error !== null)

  const checks = useMemo(
    () => buildChecks(environment, installing, install),
    [environment, installing, install],
  )
  const runnable = environment !== null && environment.node !== null && environment.harnessInstalled
  const starting = busy || status.phase === 'starting' || status.phase === 'restarting'
  const running = status.phase === 'ready'

  return (
    // `my-auto` rather than centred justification: auto margins collapse to zero
    // once the column is taller than the window, so opening the log scrolls
    // instead of clipping its top out of reach.
    <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-8">
      <div className="my-auto flex w-full max-w-[30rem] shrink-0 flex-col items-center gap-6">
        <BrandMark size={68} className="rounded-[15px] shadow-lift" />

        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-gradient-brand text-[27px] leading-none font-semibold tracking-[-0.02em]">
            DSH Studio
          </h1>
          <p className="text-[13.5px] text-muted">{t('app.tagline')}</p>
        </div>

        <StatusPill status={status} />

        <div className="w-full">
          <CheckList items={checks} />
        </div>

        {installing && <InstallProgress packages={installProgress} />}

        <div className="flex w-full flex-col gap-3">
          {running ? (
            <Button variant="primary" onClick={() => void stop()} disabled={busy}>
              <Square size={15} strokeWidth={2.5} />
              {t('action.stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void start()}
              disabled={!runnable || starting || installing}
            >
              {starting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t('action.starting')}
                </>
              ) : (
                <>
                  <Terminal size={16} strokeWidth={2.2} />
                  {status.phase === 'failed' ? t('action.retry') : t('action.start')}
                </>
              )}
            </Button>
          )}

          {error && (
            <p className="selectable rounded-control bg-danger/10 px-3 py-2 text-center text-[12.5px] text-danger">
              {error}
            </p>
          )}

          <div className="flex items-center justify-center gap-1">
            <Button variant="ghost" onClick={() => setLogPreference(!showLog)}>
              <ChevronDown
                size={14}
                className={`transition-transform duration-200 ${showLog ? '' : '-rotate-90'}`}
              />
              {showLog ? t('log.hide') : t('log.show')}
            </Button>
            {!runnable && !installing && (
              <Button variant="ghost" onClick={() => void inspect()}>
                {t('action.recheck')}
              </Button>
            )}
          </div>
        </div>

        {showLog && (
          <div className="w-full">
            <LogConsole lines={lines} />
          </div>
        )}
      </div>
    </main>
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
    <div className="w-full rounded-panel border border-line bg-surface/60 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <Loader2 size={15} className="shrink-0 animate-spin text-brand" />
        <span className="text-[13px] text-text">{t('install.working')}</span>
        {packages > 0 && (
          <span className="ml-auto font-mono text-[12px] tabular-nums text-muted">
            {t('install.progress', { count: packages })}
          </span>
        )}
      </div>
      <p className="mt-1.5 pl-[25px] text-[12px] text-faint">{t('install.slow')}</p>
    </div>
  )
}

/** Turn the environment report into the three rows the card shows. */
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
      icon: Hexagon,
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
      icon: Terminal,
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
    {
      key: 'workspace',
      icon: FolderOpen,
      label: t('check.workspace'),
      value: environment ? tail(environment.workspace) : '',
      title: environment?.workspace,
      state: 'neutral',
    },
  ]
}

/** Keep the end of a path, which is the part that identifies it. */
function tail(path: string, segments = 2): string {
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segments) return path
  return `…${separator}${parts.slice(-segments).join(separator)}`
}

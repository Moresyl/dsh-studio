/**
 * What the machine has, and what is being fetched for it.
 *
 * Split out of the console pane because the first-run guide asks the same
 * question in its first step and has to be able to answer it the same way. Both
 * read the store directly rather than taking the report as a prop: there is one
 * environment, and a second copy threaded through a component tree is a second
 * thing that can be stale.
 */
import { Check, Download, Loader2 } from 'lucide-react'

import { CheckList, type CheckItem } from '@/components/CheckList'
import { megabytes } from '@/lib/format'
import { t } from '@/lib/i18n'
import { formatVersion, type NodeProgress } from '@/lib/ipc'
import { useHarness } from '@/state/harness'

/** The two things that can be missing, each carrying the fix for itself. */
export function EnvironmentChecks() {
  const environment = useHarness((state) => state.environment)
  const installing = useHarness((state) => state.installing)
  const install = useHarness((state) => state.install)
  const provisioningNode = useHarness((state) => state.provisioningNode)
  const provisionNode = useHarness((state) => state.provisionNode)

  const node = environment?.node ?? null
  const minimum = environment ? formatVersion(environment.minimumNode) : ''
  const harnessInstalled = environment?.harnessInstalled ?? false
  const harnessCompatible = environment?.harnessCompatible ?? false
  const harnessReady = harnessInstalled && harnessCompatible
  const harnessVersion = environment?.harnessVersion ?? null
  const expectedHarnessVersion = environment?.expectedHarnessVersion ?? ''
  const harnessProblem = environment?.harnessProblem ?? null
  const workspace = environment?.workspaceAdmission ?? null

  // Only things that can be wrong. The workspace is neither a check nor
  // something anyone acts on from here, so it reports itself from the status bar
  // instead.
  const items: CheckItem[] = [
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
      value: harnessProblem
        ? t('check.harness.recoveryFailed')
        : harnessInstalled && !harnessCompatible
          ? t('check.harness.incompatible', {
              actual: harnessVersion ?? t('check.harness.unknown'),
              expected: expectedHarnessVersion,
            })
          : harnessInstalled
            ? t('check.harness.installedVersion', {
                version: harnessVersion ?? expectedHarnessVersion,
              })
            : t('check.harness.missing'),
      title: environment?.harnessEntry,
      state: environment === null ? 'neutral' : harnessReady ? 'ok' : 'missing',
      action:
        environment !== null && !harnessReady && node !== null
          ? {
              label: installing
                ? t('action.installing')
                : harnessInstalled
                  ? t('action.repair')
                  : t('action.install'),
              icon: Download,
              busy: installing,
              run: () => void install(),
            }
          : undefined,
    },
    {
      key: 'workspace',
      label: t('check.workspace'),
      value:
        workspace === null
          ? t('check.workspace.checking')
          : workspace.state === 'safe'
            ? t('check.workspace.safe', {
                filesystem: workspace.filesystem ?? t('check.workspace.local'),
              })
            : workspace.state === 'warning'
              ? t('check.workspace.warning')
              : t('check.workspace.blocked'),
      title: workspace?.reason ?? environment?.workspace,
      state: workspace === null ? 'neutral' : workspace.state === 'blocked' ? 'missing' : 'ok',
    },
  ]

  return <CheckList items={items} />
}

/**
 * Whichever of the two installs is running, or nothing at all.
 *
 * Both at once is possible — a machine with no Node gets the runtime and then the
 * packages — and they are stacked rather than merged into one bar, because they
 * are separate downloads with separate things to say about how far along they are.
 */
export function EnvironmentProgress() {
  const provisioningNode = useHarness((state) => state.provisioningNode)
  const nodeProgress = useHarness((state) => state.nodeProgress)
  const installing = useHarness((state) => state.installing)
  const installProgress = useHarness((state) => state.installProgress)

  if (!provisioningNode && !installing) return null

  return (
    <div className="flex flex-col gap-2">
      {provisioningNode && <NodeInstallProgress progress={nodeProgress} />}
      {installing && <InstallProgress packages={installProgress} />}
    </div>
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

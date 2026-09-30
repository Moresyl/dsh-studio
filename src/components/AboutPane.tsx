import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpRight,
  Check,
  Copy,
  Download,
  FileDown,
  FolderOpen,
  Bug,
  Lightbulb,
  Loader2,
  RefreshCw,
  Scale,
  MessagesSquare,
  History,
} from 'lucide-react'
import { save as pickPath } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/Button'
import { PaneHeader } from '@/components/PaneHeader'
import { UpdateProgress } from '@/components/UpdateProgress'
import { VersionHistory } from '@/components/VersionHistory'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import { openExternalUrl } from '@/lib/external-url'
import * as ipc from '@/lib/ipc'
import type { About } from '@/lib/ipc'
import { notesForDisplay } from '@/lib/updater'
import { contextMenu } from '@/state/menu'
import { ask } from '@/state/dialog'
import { reportAction, reportFailure } from '@/state/failure'
import { useUpdate } from '@/state/update'

/** Where this build comes from. Our own repository, and the only link here. */
const SOURCE = 'https://github.com/Moresyl/dsh-studio'
const BUGS = `${SOURCE}/issues/new?template=bug_report.yml`
const FEATURES = `${SOURCE}/issues/new?template=feature_request.yml`
const DISCUSSIONS = `${SOURCE}/discussions`

/**
 * What this build is, and where it put things.
 *
 * Every fact on this pane exists because it is the first thing asked for when
 * something has gone wrong: which version, which platform, and which directory
 * the install went wrong in. The paths are therefore not text to read out over a
 * support thread — each one opens in the file manager, because the next step
 * after learning a path is always going to look at it.
 *
 * The update state is shared with the status bar rather than fetched again here.
 * Two panels asking the same question of the same feed is how an app ends up
 * telling a user two different things about which version they are on. The
 * signed updater also owns the download: this pane only starts it after a click.
 *
 * The diagnostic report is here for the same reason the paths are. This is the
 * pane somebody opens once something has gone wrong, and the report is every
 * question that thread was going to ask, answered before it is sent.
 */
export function AboutPane() {
  const [about, setAbout] = useState<About | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [copied, setCopied] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  const release = useUpdate((state) => state.release)
  const targetRelease = useUpdate((state) => state.targetRelease)
  const checked = useUpdate((state) => state.checked)
  const checking = useUpdate((state) => state.checking)
  const manualChecking = useUpdate((state) => state.manualChecking)
  const checkedAt = useUpdate((state) => state.checkedAt)
  const installing = useUpdate((state) => state.installing)
  const checkFailure = useUpdate((state) => state.error)
  const check = useUpdate((state) => state.check)
  const install = useUpdate((state) => state.runInstall)

  useEffect(() => {
    void ipc
      .about()
      .then(setAbout)
      .catch((cause: unknown) => setError(describe(cause)))
  }, [])

  const fail = useCallback((cause: unknown) => {
    setError(reportFailure(cause))
  }, [])

  const reveal = (path: string) => {
    void revealItemInDir(path).catch(fail)
  }

  /**
   * Gather the report, which is the slow half of both buttons.
   *
   * Slow because it asks every Node runtime on the machine for its version, so
   * the spinner is on the button rather than nowhere — and off again before any
   * dialog opens, since waiting on a person is not work to show progress for.
   */
  const build = useCallback(async () => {
    setBuilding(true)
    setError(null)
    try {
      return await ipc.reportBuild()
    } catch (cause) {
      fail(cause)
      return null
    } finally {
      setBuilding(false)
    }
  }, [fail])

  const copyReport = useCallback(async () => {
    const report = await build()
    if (!report) return

    // The webview's own clipboard rather than a plugin: this document is served
    // from localhost, a secure context, and a click is the gesture it asks for.
    try {
      await navigator.clipboard.writeText(report.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch (cause) {
      fail(cause)
    }
  }, [build, fail])

  const saveReport = useCallback(async () => {
    const report = await build()
    if (!report) return

    try {
      const path = await pickPath({
        title: t('about.reportTitle'),
        defaultPath: report.archiveName,
        filters: [{ name: t('about.reportKind'), extensions: ['zip'] }],
      })
      // Dismissed, which is an answer rather than a failure.
      if (!path) return
      await ipc.reportArchive(path, report.text)
      await revealItemInDir(path)
    } catch (cause) {
      fail(cause)
    }
  }, [build, fail])

  const shownRelease = installing ? targetRelease : release
  const notes = shownRelease ? notesForDisplay(shownRelease.notes) : ''

  return (
    <>
      <section className="flex min-h-0 flex-1 animate-rise flex-col">
        <PaneHeader title={t('about.title')} subtitle={t('about.subtitle')} width="narrow">
          <Button variant="secondary" onClick={() => setHistoryOpen(true)} disabled={installing}>
            <History aria-hidden="true" />
            {t('versions.title')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void check()}
            disabled={manualChecking || installing}
          >
            {checking ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                {t('about.checking')}
              </>
            ) : (
              <>
                <RefreshCw aria-hidden="true" />
                {t('about.check')}
              </>
            )}
          </Button>
        </PaneHeader>

        <div className="min-h-0 flex-1 overflow-y-auto bg-canvas px-6 pb-6">
          <div className="mx-auto flex w-full max-w-[780px] flex-col gap-6">
            <div className="flex flex-col gap-3">
              {/* Always mounted, because a live region has to exist before it has
                  anything to announce — and pulled back by its own gap while it is
                  empty, so the card below sits where it would if this were not here. */}
              <p role="status" aria-live="polite" className="text-ui-sm text-muted empty:-mb-3">
                {checking
                  ? t('about.checkingDetail')
                  : checked && checkedAt !== null
                    ? t('about.checkedAt', { time: new Date(checkedAt).toLocaleTimeString() })
                    : null}
              </p>

              <div className="card card--pad flex items-center gap-4">
                <BrandMark size={52} className="shrink-0 rounded-lg shadow-lift" />
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-ui-lg font-semibold text-text">DSH Studio</h3>
                  <p className="selectable font-mono text-ui-sm text-muted tabular-nums">
                    {about
                      ? `${about.version} · ${about.platform}-${about.arch} · ${t(`about.edition.${about.edition}`)}`
                      : '—'}
                  </p>
                </div>
              </div>

              {shownRelease ? (
                <div className="card flex flex-col gap-3 border-brand/30 bg-brand/10 p-4 text-ui-base text-text">
                  <div className="flex flex-col gap-1.5">
                    <strong className="font-semibold">
                      {installing
                        ? `${t('about.updating')} · ${shownRelease.version}`
                        : t('about.available', { version: shownRelease.version })}
                    </strong>
                    {notes && (
                      <p className="selectable max-h-40 overflow-y-auto whitespace-pre-line text-ui-sm text-muted">
                        {notes}
                      </p>
                    )}
                  </div>

                  {installing && !historyOpen && <UpdateProgress />}
                  {!shownRelease.canInstall && (
                    <p className="text-ui-sm text-muted">
                      {t(
                        shownRelease.installBlock === 'rpmDowngrade'
                          ? 'versions.rpmDowngrade'
                          : 'versions.development',
                      )}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => void reportAction(() => openExternalUrl(shownRelease.url))}
                    >
                      {t('about.release')}
                      <ArrowUpRight aria-hidden="true" />
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() =>
                        void (async () => {
                          if (
                            await ask({
                              title: t('versions.confirmInstall'),
                              body: t('versions.installBody'),
                              subject: `${shownRelease.currentVersion} → ${shownRelease.version}`,
                              confirm: t('versions.installRestart'),
                              tone: 'brand',
                            })
                          )
                            await install(shownRelease, 'latest')
                        })()
                      }
                      disabled={installing || checking || !shownRelease.canInstall}
                    >
                      {installing ? (
                        <Loader2 className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Download aria-hidden="true" />
                      )}
                      {installing ? t('about.updating') : t('about.install')}
                    </Button>
                  </div>
                </div>
              ) : checked ? (
                <div className="card px-4 py-3 text-ui-base text-muted">{t('about.current')}</div>
              ) : null}

              {(error ?? checkFailure) && (
                <p className="selectable rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger [overflow-wrap:anywhere]">
                  {error ?? checkFailure}
                </p>
              )}
            </div>

            <section className="flex flex-col gap-2">
              <h3 className="caption">{t('about.paths')}</h3>
              <dl className="list-card">
                <PathRow label={t('about.appData')} path={about?.appData} onReveal={reveal} />
                <PathRow label={t('about.harnessDir')} path={about?.harnessDir} onReveal={reveal} />
                <PathRow label={t('about.profileDir')} path={about?.profileDir} onReveal={reveal} />
              </dl>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="caption">{t('about.diagnostics')}</h3>
              <div className="card card--pad flex flex-col gap-3">
                <p className="text-ui-base text-muted">{t('about.diagnosticsBody')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => void copyReport()}
                    disabled={building}
                    data-hint={t('about.reportHint')}
                  >
                    {copied ? (
                      <Check className="text-ok" aria-hidden="true" />
                    ) : building ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Copy aria-hidden="true" />
                    )}
                    {copied ? t('statusbar.copied') : t('about.reportCopy')}
                  </Button>
                  <Button variant="secondary" onClick={() => void saveReport()} disabled={building}>
                    <FileDown aria-hidden="true" />
                    {t('about.reportSave')}
                  </Button>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="caption">{t('about.community')}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <CommunityLink icon={Bug} label={t('about.reportBug')} url={BUGS} />
                <CommunityLink icon={Lightbulb} label={t('about.requestFeature')} url={FEATURES} />
                <CommunityLink
                  icon={MessagesSquare}
                  label={t('about.discussions')}
                  url={DISCUSSIONS}
                />
              </div>
            </section>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void reportAction(() => openExternalUrl(SOURCE))}
                className="-ml-2"
              >
                <ArrowUpRight aria-hidden="true" />
                {t('about.source')}
              </Button>
              {/* A statement, not a link — so it is not a button either. */}
              <span className="inline-flex items-center gap-1.5 text-ui-sm text-faint">
                <Scale size={14} strokeWidth={1.8} aria-hidden="true" />
                {t('about.license')}
              </span>
            </div>
          </div>
        </div>
      </section>
      {historyOpen && <VersionHistory onClose={() => setHistoryOpen(false)} />}
    </>
  )
}

function CommunityLink({
  icon: Icon,
  label,
  url,
}: {
  icon: typeof Bug
  label: string
  url: string
}) {
  return (
    <Button
      variant="secondary"
      size="lg"
      onClick={() => void reportAction(() => openExternalUrl(url))}
      className="w-full"
    >
      <Icon aria-hidden="true" />
      {label}
    </Button>
  )
}

interface PathRowProps {
  label: string
  /** Absent until the About report lands. */
  path: string | undefined
  onReveal: (path: string) => void
}

function PathRow({ label, path, onReveal }: PathRowProps) {
  return (
    <div className="list-row">
      <dt className="shrink-0 text-ui-base text-muted">{label}</dt>
      <dd className="-mr-2.5 ml-auto min-w-0">
        {path ? (
          <Button
            variant="ghost"
            size="sm"
            data-hint={`${path}\n${t('statusbar.reveal')}`}
            onClick={() => onReveal(path)}
            onContextMenu={contextMenu([
              { label: t('statusbar.reveal'), icon: FolderOpen, run: () => onReveal(path) },
              {
                label: t('menu.copyPath'),
                icon: Copy,
                run: () => void reportAction(() => navigator.clipboard.writeText(path)),
              },
            ])}
            className="max-w-full min-w-0 shrink font-mono"
          >
            <FolderOpen aria-hidden="true" />
            <span className="truncate text-text">{path}</span>
          </Button>
        ) : (
          <span className="font-mono text-ui-sm text-faint">—</span>
        )}
      </dd>
    </div>
  )
}

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
} from 'lucide-react'
import { save as pickPath } from '@tauri-apps/plugin-dialog'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'

import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/Button'
import { PaneHeader } from '@/components/PaneHeader'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import type { About } from '@/lib/ipc'
import { notesForDisplay } from '@/lib/updater'
import { contextMenu } from '@/state/menu'
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

  const release = useUpdate((state) => state.release)
  const checked = useUpdate((state) => state.checked)
  const checking = useUpdate((state) => state.checking)
  const installing = useUpdate((state) => state.installing)
  const progress = useUpdate((state) => state.progress)
  const checkFailure = useUpdate((state) => state.error)
  const check = useUpdate((state) => state.check)
  const install = useUpdate((state) => state.install)

  useEffect(() => {
    void ipc
      .about()
      .then(setAbout)
      .catch((cause: unknown) => setError(describe(cause)))
  }, [])

  const reveal = (path: string) => {
    void revealItemInDir(path).catch((cause: unknown) => setError(describe(cause)))
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
      setError(describe(cause))
      return null
    } finally {
      setBuilding(false)
    }
  }, [])

  const copyReport = useCallback(async () => {
    const report = await build()
    if (!report) return

    // The webview's own clipboard rather than a plugin: this document is served
    // from localhost, a secure context, and a click is the gesture it asks for.
    await navigator.clipboard.writeText(report.text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }, [build])

  const saveReport = useCallback(async () => {
    const report = await build()
    if (!report) return

    const path = await pickPath({
      title: t('about.reportTitle'),
      defaultPath: report.archiveName,
      filters: [{ name: t('about.reportKind'), extensions: ['zip'] }],
    })
    // Dismissed, which is an answer rather than a failure.
    if (!path) return

    try {
      await ipc.reportArchive(path, report.text)
      await revealItemInDir(path)
    } catch (cause) {
      setError(describe(cause))
    }
  }, [build])

  const notes = release ? notesForDisplay(release.notes) : ''
  const percent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null

  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col">
      <PaneHeader title={t('about.title')} subtitle={t('about.subtitle')}>
        <Button variant="secondary" onClick={() => void check()} disabled={checking || installing}>
          {checking ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              {t('about.checking')}
            </>
          ) : (
            <>
              <RefreshCw size={13} strokeWidth={2.2} />
              {t('about.check')}
            </>
          )}
        </Button>
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas px-6 py-6">
        <div className="mx-auto flex max-w-[620px] flex-col gap-4">
          <div className="flex items-center gap-4 rounded-panel border border-line bg-canvas-deep/50 px-5 py-4">
            <BrandMark size={52} className="shrink-0 rounded-[12px] shadow-lift" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <h3 className="text-[16px] leading-none font-semibold tracking-[-0.01em] text-text">
                DSH Studio
              </h3>
              <p className="selectable font-mono text-[11.5px] text-muted tabular-nums">
                {about
                  ? `${about.version} · ${about.platform}-${about.arch} · ${t(`about.edition.${about.edition}`)}`
                  : '—'}
              </p>
            </div>
          </div>

          {release ? (
            <div className="flex flex-col gap-3 rounded-panel border border-brand/30 bg-brand/10 px-4 py-3 text-[12.5px] text-text">
              <div className="flex flex-col gap-1.5">
                <strong className="font-semibold">
                  {t('about.available', { version: release.version })}
                </strong>
                {notes && (
                  <p className="selectable max-h-[168px] overflow-y-auto whitespace-pre-line text-[12px] leading-relaxed text-muted">
                    {notes}
                  </p>
                )}
              </div>

              {installing && (
                <div className="flex flex-col gap-1.5" aria-live="polite">
                  <div className="flex items-center justify-between text-[11px] text-muted tabular-nums">
                    <span>
                      {percent === 100
                        ? t('about.installing')
                        : percent === null
                          ? t('about.downloading')
                          : t('about.downloadingPercent', { percent })}
                    </span>
                    {percent !== null && <span>{percent}%</span>}
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-canvas-deep/70">
                    <div
                      className={[
                        'h-full rounded-full bg-brand transition-[width] duration-150',
                        percent === null ? 'w-1/3 animate-pulse' : '',
                      ].join(' ')}
                      style={percent === null ? undefined : { width: `${percent}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2">
                <Button variant="secondary" onClick={() => void openUrl(release.url)}>
                  {t('about.release')}
                  <ArrowUpRight size={13} strokeWidth={2.3} />
                </Button>
                <Button variant="primary" onClick={() => void install()} disabled={installing}>
                  {installing ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Download size={13} strokeWidth={2.3} />
                  )}
                  {installing ? t('about.updating') : t('about.install')}
                </Button>
              </div>
            </div>
          ) : checked ? (
            <div className="rounded-panel border border-line bg-canvas-deep/50 px-4 py-3 text-[12.5px] text-muted">
              {t('about.current')}
            </div>
          ) : null}

          {(error ?? checkFailure) && (
            <p className="selectable rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-danger">
              {error ?? checkFailure}
            </p>
          )}

          <section className="flex flex-col gap-2">
            <h4 className="caption">{t('about.paths')}</h4>
            <dl className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-canvas-deep/50">
              <PathRow label={t('about.appData')} path={about?.appData} onReveal={reveal} />
              <PathRow label={t('about.harnessDir')} path={about?.harnessDir} onReveal={reveal} />
              <PathRow label={t('about.profileDir')} path={about?.profileDir} onReveal={reveal} />
            </dl>
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="caption">{t('about.diagnostics')}</h4>
            <div className="flex flex-col gap-3 rounded-panel border border-line bg-canvas-deep/50 px-4 py-3.5">
              <p className="text-[12px] leading-relaxed text-muted">{t('about.diagnosticsBody')}</p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void copyReport()}
                  disabled={building}
                  data-hint={t('about.reportHint')}
                >
                  {copied ? (
                    <Check size={13} strokeWidth={2.6} className="text-ok" />
                  ) : building ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Copy size={13} strokeWidth={2.1} />
                  )}
                  {copied ? t('statusbar.copied') : t('about.reportCopy')}
                </Button>
                <Button variant="secondary" onClick={() => void saveReport()} disabled={building}>
                  <FileDown size={13} strokeWidth={2.2} aria-hidden="true" />
                  {t('about.reportSave')}
                </Button>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="caption">{t('about.community')}</h4>
            <div className="grid grid-cols-3 gap-2">
              <CommunityLink icon={Bug} label={t('about.reportBug')} url={BUGS} />
              <CommunityLink icon={Lightbulb} label={t('about.requestFeature')} url={FEATURES} />
              <CommunityLink
                icon={MessagesSquare}
                label={t('about.discussions')}
                url={DISCUSSIONS}
              />
            </div>
          </section>

          <div className="flex items-center gap-4 text-[11.5px] text-faint">
            <button
              type="button"
              onClick={() => void openUrl(SOURCE)}
              className="inline-flex items-center gap-1.5 transition-colors duration-100 hover:text-brand"
            >
              <ArrowUpRight size={12} strokeWidth={2.2} aria-hidden="true" />
              {t('about.source')}
            </button>
            <span className="inline-flex items-center gap-1.5">
              <Scale size={12} strokeWidth={2} aria-hidden="true" />
              {t('about.license')}
            </span>
          </div>
        </div>
      </div>
    </section>
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
    <button
      type="button"
      onClick={() => void openUrl(url)}
      className="flex items-center justify-center gap-2 rounded-control border border-line bg-canvas-deep/50 px-3 py-2.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-brand"
    >
      <Icon size={13} strokeWidth={2.1} aria-hidden="true" />
      {label}
    </button>
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
    <div className="flex h-[34px] items-center gap-3 px-3">
      <dt className="shrink-0 text-[12px] text-muted">{label}</dt>
      <dd className="ml-auto min-w-0">
        {path ? (
          <button
            type="button"
            data-hint={`${path}\n${t('statusbar.reveal')}`}
            onClick={() => onReveal(path)}
            onContextMenu={contextMenu([
              { label: t('statusbar.reveal'), icon: FolderOpen, run: () => onReveal(path) },
              {
                label: t('menu.copyPath'),
                icon: Copy,
                run: () => void navigator.clipboard.writeText(path),
              },
            ])}
            className="flex max-w-full items-center gap-1.5 font-mono text-[11.5px] text-muted transition-colors duration-100 hover:text-brand"
          >
            <FolderOpen size={11} strokeWidth={2} className="shrink-0 text-faint" />
            <span className="truncate">{path}</span>
          </button>
        ) : (
          <span className="font-mono text-[11.5px] text-faint">—</span>
        )}
      </dd>
    </div>
  )
}

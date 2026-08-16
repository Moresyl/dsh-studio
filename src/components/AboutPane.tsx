import { useEffect, useState } from 'react'
import { ArrowUpRight, FolderOpen, Loader2, RefreshCw, Scale } from 'lucide-react'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'

import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/Button'
import { PaneHeader } from '@/components/PaneHeader'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import type { About, Release } from '@/lib/ipc'

/** Where this build comes from. Our own repository, and the only link here. */
const SOURCE = 'https://github.com/Moresyl/dsh-studio'

/**
 * What this build is, and where it put things.
 *
 * Every fact on this pane exists because it is the first thing asked for when
 * something has gone wrong: which version, which platform, and which directory
 * the install went wrong in. The paths are therefore not text to read out over a
 * support thread — each one opens in the file manager, because the next step
 * after learning a path is always going to look at it.
 *
 * The update check is a button and never a startup task. An app that contacts a
 * server the moment it opens has made a decision on the user's behalf about what
 * their machine tells the internet, and nothing here is urgent enough to earn
 * that. Nothing is downloaded either — this reads a version and offers a link.
 */
export function AboutPane() {
  const [about, setAbout] = useState<About | null>(null)
  const [release, setRelease] = useState<Release | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void ipc
      .about()
      .then(setAbout)
      .catch((cause: unknown) => setError(describe(cause)))
  }, [])

  const check = async () => {
    setChecking(true)
    setError(null)
    try {
      setRelease(await ipc.checkUpdate())
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setChecking(false)
    }
  }

  const reveal = (path: string) => {
    void revealItemInDir(path).catch((cause: unknown) => setError(describe(cause)))
  }

  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col">
      <PaneHeader title={t('about.title')} subtitle={t('about.subtitle')}>
        <Button variant="secondary" onClick={() => void check()} disabled={checking}>
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
                {about ? `${about.version} · ${about.platform}-${about.arch}` : '—'}
              </p>
            </div>
          </div>

          {release && (
            <div
              className={[
                'flex items-center gap-2.5 rounded-panel border px-4 py-3 text-[12.5px]',
                release.newer
                  ? 'border-brand/30 bg-brand/10 text-text'
                  : 'border-line bg-canvas-deep/50 text-muted',
              ].join(' ')}
            >
              <span className="min-w-0 flex-1">
                {release.newer
                  ? t('about.available', { version: release.version })
                  : t('about.current')}
              </span>
              {release.newer && (
                <Button variant="primary" onClick={() => void openUrl(release.url)}>
                  {t('about.release')}
                  <ArrowUpRight size={13} strokeWidth={2.3} />
                </Button>
              )}
            </div>
          )}

          {error && (
            <p className="selectable rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-danger">
              {error}
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
            title={`${path}\n${t('statusbar.reveal')}`}
            onClick={() => onReveal(path)}
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

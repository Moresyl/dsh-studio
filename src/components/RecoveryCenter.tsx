import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  Archive,
  CheckCircle2,
  LifeBuoy,
  Loader2,
  RotateCcw,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'
import { save as pickPath } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import { Button } from '@/components/Button'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { holdFocus } from '@/lib/modal'
import { useHarness } from '@/state/harness'
import { useProfiles } from '@/state/profiles'

type Preview =
  | { kind: 'plugin-retry' }
  | { kind: 'profile-retry' }
  | { kind: 'profile-disable'; subject: string }

/**
 * Startup recovery is owned by the native shell and does not depend on a
 * working Harness renderer. Plugin and profile notices share one queue so two
 * failures can never stack two modal backdrops over each other.
 */
export function RecoveryCenter() {
  const harnessPhase = useHarness((state) => state.status.phase)
  const [plugin, setPlugin] = useState<ipc.PluginRecoveryNotice | null>(null)
  const [profile, setProfile] = useState<ipc.ProfileStartupRecovery | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [evidenceGeneration, setEvidenceGeneration] = useState<string | null>(null)
  const [evidencePath, setEvidencePath] = useState<string | null>(null)
  const [working, setWorking] = useState<'evidence' | 'apply' | 'safe-mode' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    void Promise.all([ipc.pluginRecoveryNotice(), ipc.profileRecoveryNotice()])
      .then(([pluginNotice, profileNotice]) => {
        if (!active) return
        setPlugin(pluginNotice)
        setProfile(profileNotice)
      })
      .catch((cause: unknown) => {
        if (active) setError(describe(cause))
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (harnessPhase !== 'ready') return
    let active = true
    void ipc
      .profileRecoveryNotice()
      .then((notice) => {
        if (active) setProfile(notice)
      })
      .catch((cause: unknown) => {
        if (active) setError(describe(cause))
      })
    return () => {
      active = false
    }
  }, [harnessPhase])

  const current = useMemo(
    () =>
      plugin
        ? ({ kind: 'plugin', notice: plugin } as const)
        : profile
          ? ({ kind: 'profile', notice: profile } as const)
          : null,
    [plugin, profile],
  )
  const generation = current?.notice.generation ?? ''
  const evidenceReady = generation.length > 0 && evidenceGeneration === generation

  const dismiss = useCallback(async () => {
    if (!current || working !== null) return
    setError(null)
    try {
      if (current.kind === 'plugin') {
        await ipc.pluginRecoveryAcknowledge()
        setPlugin(null)
      } else {
        await ipc.profileRecoveryAcknowledge()
        setProfile(null)
      }
      setPreview(null)
    } catch (cause) {
      setError(describe(cause))
    }
  }, [current, working])

  const saveEvidence = useCallback(async () => {
    if (!current || generation.length === 0 || working !== null) return
    setWorking('evidence')
    setError(null)
    try {
      const report = await ipc.reportBuild()
      const path = await pickPath({
        title: t('recovery.evidence'),
        defaultPath: report.archiveName,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (!path) return
      await ipc.reportArchive(path, report.text)
      setEvidenceGeneration(generation)
      setEvidencePath(path)
      await revealItemInDir(path)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setWorking(null)
    }
  }, [current, generation, working])

  const applyPreview = useCallback(async () => {
    if (!preview || !current || !evidenceReady || working !== null) return
    setWorking('apply')
    setError(null)
    try {
      if (preview.kind === 'plugin-retry' && current.kind === 'plugin') {
        await ipc.pluginRecoveryRetry(generation)
        setPlugin(null)
      } else if (preview.kind === 'profile-disable' && current.kind === 'profile') {
        setProfile(await ipc.profileRecoveryDisablePlugin(preview.subject, generation))
      } else if (preview.kind === 'profile-retry' && current.kind === 'profile') {
        await ipc.profileRecoveryRetry(generation)
        await useProfiles.getState().refresh()
        await ipc.start()
        const after = await ipc.profileRecoveryNotice()
        if (after && after.generation !== generation) {
          setProfile(after)
        } else {
          await ipc.profileRecoveryAcknowledge()
          setProfile(null)
        }
      } else {
        throw new Error('The recovery preview no longer matches the current operation.')
      }
      setPreview(null)
    } catch (cause) {
      setError(describe(cause))
      if (current.kind === 'profile') {
        const after = await ipc.profileRecoveryNotice().catch(() => null)
        if (after) setProfile(after)
      }
    } finally {
      setWorking(null)
    }
  }, [current, evidenceReady, generation, preview, working])

  const startSafeMode = useCallback(async () => {
    if (!current || working !== null) return
    setWorking('safe-mode')
    setError(null)
    try {
      await ipc.startSafeMode()
      // Keep the native recovery record for the next ordinary start, but let
      // this window reach the isolated renderer now so diagnostics and profile
      // repairs remain available.
      setPlugin(null)
      setProfile(null)
      setPreview(null)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setWorking(null)
    }
  }, [current, working])

  if (!loaded || current === null) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    holdFocus(card.current, event, () => void dismiss())
  const previewText =
    preview?.kind === 'plugin-retry' && current.kind === 'plugin'
      ? current.notice.retry?.kind === 'add'
        ? t('recovery.previewAdd', { subject: current.notice.subject })
        : t('recovery.previewRemove', { subject: current.notice.subject })
      : preview?.kind === 'profile-retry' && current.kind === 'profile'
        ? t('recovery.previewStart', { profile: current.notice.failedProfile })
        : preview?.kind === 'profile-disable' && current.kind === 'profile'
          ? t('recovery.previewDisable', {
              profile: current.notice.failedProfile,
              subject: preview.subject,
            })
          : ''

  // Three outcomes, one tile: a plugin profile put back is the good news, one
  // that could not be is the failure, and a profile that would not start is the
  // warning the rest of this dialog is about.
  const status =
    current.kind === 'plugin'
      ? current.notice.restored
        ? { Icon: CheckCircle2, tone: 'bg-ok/12 text-ok' }
        : { Icon: TriangleAlert, tone: 'bg-danger/12 text-danger' }
      : { Icon: ShieldAlert, tone: 'bg-warn/12 text-warn' }

  return (
    <div
      role="presentation"
      onKeyDown={onKeyDown}
      // One layer above the confirm dialog's: a startup failure is answered
      // first, and nothing raised behind it may cover it.
      className="dialog-backdrop fixed inset-0 z-50 grid animate-fade place-items-center bg-canvas-deep/65 px-8 backdrop-blur-[2px]"
    >
      {/* The large-modal shape: the header and the actions stay put and the
          body between them scrolls, so a profile with a long list of plugins
          or a short window never pushes the buttons off the screen. */}
      <div
        ref={card}
        role="alertdialog"
        aria-modal="true"
        aria-label={t('recovery.centerTitle')}
        className="dialog-panel flex max-h-[min(720px,calc(100vh-64px))] w-full max-w-[560px] animate-pop flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lift"
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span
            aria-hidden="true"
            className={`grid size-9 shrink-0 place-items-center rounded-lg ${status.tone}`}
          >
            <status.Icon size={18} strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1 pt-1.5">
            <h2 className="text-ui-lg font-semibold text-text">{t('recovery.centerTitle')}</h2>
            <p className="mt-1 text-ui-base text-muted">
              {current.kind === 'plugin'
                ? current.notice.restored
                  ? t('recovery.restored')
                  : t('recovery.failed')
                : current.notice.recoveredProfile
                  ? t('profileRecovery.rolledBack', {
                      failed: current.notice.failedProfile,
                      recovered: current.notice.recoveredProfile,
                    })
                  : t('profileRecovery.noFallback', { failed: current.notice.failedProfile })}
            </p>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          <dl className="list-card">
            <Fact
              label={t('recovery.profile')}
              value={
                current.kind === 'plugin' ? current.notice.profile : current.notice.failedProfile
              }
            />
            {current.kind === 'plugin' && (
              <>
                <Fact label={t('recovery.operation')} value={current.notice.operation} />
                <Fact label={t('recovery.subject')} value={current.notice.subject} />
              </>
            )}
          </dl>

          {preview ? (
            <div className="flex flex-col gap-2 rounded-xl border border-brand/40 bg-brand/5 px-4 py-3">
              <p className="text-ui-base font-medium text-text">{t('recovery.previewTitle')}</p>
              <p className="text-ui-base text-muted">{previewText}</p>
              <p className="text-ui-sm text-faint">{t('recovery.changedGuard')}</p>
            </div>
          ) : current.kind === 'plugin' ? (
            <p className="text-ui-base text-muted">
              {current.notice.retry ? t('recovery.evidenceHint') : t('recovery.noRetry')}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-ui-base text-muted">{t('profileRecovery.disableHint')}</p>
              {current.notice.plugins.length > 0 && (
                <ul className="list-card">
                  {current.notice.plugins.map((name) => (
                    <li key={name} className="list-row">
                      <code className="min-w-0 flex-1 truncate font-mono text-ui-sm text-text">
                        {name}
                      </code>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={working !== null}
                        onClick={() => setPreview({ kind: 'profile-disable', subject: name })}
                      >
                        {t('profileRecovery.disable')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="card flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-ui-sm text-muted">
                {evidenceReady ? t('recovery.evidenceReady') : t('recovery.evidenceHint')}
              </p>
              <Button
                variant="secondary"
                disabled={working !== null}
                onClick={() => void saveEvidence()}
              >
                {working === 'evidence' ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Archive aria-hidden="true" />
                )}
                {working === 'evidence' ? t('recovery.exporting') : t('recovery.evidence')}
              </Button>
            </div>
            {evidenceReady && evidencePath && (
              <p className="truncate font-mono text-ui-sm text-faint">
                {t('recovery.savedAt', { path: evidencePath })}
              </p>
            )}
          </div>

          {error && (
            <p className="selectable rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
          {preview ? (
            <>
              <Button variant="ghost" disabled={working !== null} onClick={() => setPreview(null)}>
                {t('recovery.back')}
              </Button>
              <Button
                variant="primary"
                disabled={!evidenceReady || working !== null}
                onClick={() => void applyPreview()}
              >
                {working === 'apply' ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCcw aria-hidden="true" />
                )}
                {working === 'apply' ? t('recovery.retrying') : t('recovery.apply')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                disabled={working !== null}
                onClick={() => void startSafeMode()}
              >
                {working === 'safe-mode' ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <LifeBuoy aria-hidden="true" />
                )}
                {working === 'safe-mode' ? t('recovery.safeModeStarting') : t('recovery.safeMode')}
              </Button>
              <Button variant="ghost" disabled={working !== null} onClick={() => void dismiss()}>
                {t('recovery.continue')}
              </Button>
              {current.kind === 'plugin' && current.notice.retry && (
                <Button
                  variant="primary"
                  disabled={working !== null}
                  onClick={() => setPreview({ kind: 'plugin-retry' })}
                >
                  {t('recovery.retryPreview')}
                </Button>
              )}
              {current.kind === 'profile' && (
                <Button
                  variant="primary"
                  disabled={working !== null}
                  onClick={() => setPreview({ kind: 'profile-retry' })}
                >
                  {t('profileRecovery.retryPreview')}
                </Button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  )
}

/** One fact about what failed, as a row of the list above the actions. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="list-row">
      <dt className="shrink-0 text-ui-base text-muted">{label}</dt>
      <dd className="ml-auto min-w-0 truncate font-mono text-ui-sm text-text">{value}</dd>
    </div>
  )
}

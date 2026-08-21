import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Archive, CheckCircle2, Loader2, RotateCcw, ShieldAlert, TriangleAlert } from 'lucide-react'
import { save as pickPath } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import { Button } from '@/components/Button'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { holdFocus } from '@/lib/modal'
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
  const [plugin, setPlugin] = useState<ipc.PluginRecoveryNotice | null>(null)
  const [profile, setProfile] = useState<ipc.ProfileStartupRecovery | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [evidenceGeneration, setEvidenceGeneration] = useState<string | null>(null)
  const [evidencePath, setEvidencePath] = useState<string | null>(null)
  const [working, setWorking] = useState<'evidence' | 'apply' | null>(null)
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

  return (
    <div
      role="presentation"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 grid place-items-center bg-canvas-deep/80 p-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="alertdialog"
        aria-modal="true"
        aria-label={t('recovery.centerTitle')}
        className="w-full max-w-[560px] rounded-panel border border-line-strong bg-surface p-5 shadow-lift"
      >
        <div className="flex items-start gap-3">
          {current.kind === 'plugin' && current.notice.restored ? (
            <CheckCircle2 size={21} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
          ) : current.kind === 'plugin' ? (
            <TriangleAlert size={21} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
          ) : (
            <ShieldAlert size={21} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold text-text">{t('recovery.centerTitle')}</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
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

            <dl className="mt-3 grid grid-cols-[92px_1fr] gap-x-3 gap-y-1.5 rounded-control border border-line bg-canvas-deep/55 p-3 text-[11px]">
              <dt className="text-faint">{t('recovery.profile')}</dt>
              <dd className="truncate font-mono text-muted">
                {current.kind === 'plugin' ? current.notice.profile : current.notice.failedProfile}
              </dd>
              {current.kind === 'plugin' && (
                <>
                  <dt className="text-faint">{t('recovery.operation')}</dt>
                  <dd className="truncate font-mono text-muted">{current.notice.operation}</dd>
                  <dt className="text-faint">{t('recovery.subject')}</dt>
                  <dd className="truncate font-mono text-muted">{current.notice.subject}</dd>
                </>
              )}
            </dl>

            {preview ? (
              <div className="mt-4 rounded-control border border-brand/40 bg-brand/5 p-3">
                <p className="text-[11.5px] font-medium text-text">{t('recovery.previewTitle')}</p>
                <p className="mt-2 text-[11px] leading-relaxed text-muted">{previewText}</p>
                <p className="mt-1.5 text-[10.5px] leading-relaxed text-faint">
                  {t('recovery.changedGuard')}
                </p>
              </div>
            ) : current.kind === 'plugin' ? (
              <p className="mt-3 text-[11px] text-muted">
                {current.notice.retry ? t('recovery.evidenceHint') : t('recovery.noRetry')}
              </p>
            ) : (
              <div className="mt-4">
                <p className="mb-2 text-[11.5px] text-muted">{t('profileRecovery.disableHint')}</p>
                <div className="max-h-36 space-y-1.5 overflow-auto">
                  {current.notice.plugins.map((name) => (
                    <div
                      key={name}
                      className="flex items-center gap-3 rounded-control border border-line bg-canvas-deep/35 px-3 py-2"
                    >
                      <code className="min-w-0 flex-1 truncate text-[11px] text-text">{name}</code>
                      <Button
                        variant="secondary"
                        disabled={working !== null}
                        onClick={() => setPreview({ kind: 'profile-disable', subject: name })}
                      >
                        {t('profileRecovery.disable')}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 rounded-control border border-line bg-canvas-deep/35 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-muted">
                  {evidenceReady ? t('recovery.evidenceReady') : t('recovery.evidenceHint')}
                </p>
                <Button
                  variant="secondary"
                  disabled={working !== null}
                  onClick={() => void saveEvidence()}
                >
                  {working === 'evidence' ? (
                    <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Archive size={13} aria-hidden="true" />
                  )}
                  {working === 'evidence' ? t('recovery.exporting') : t('recovery.evidence')}
                </Button>
              </div>
              {evidenceReady && evidencePath && (
                <p className="mt-2 truncate font-mono text-[10px] text-faint">
                  {t('recovery.savedAt', { path: evidencePath })}
                </p>
              )}
            </div>
            {error && <p className="mt-3 text-[11px] text-danger">{error}</p>}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {preview ? (
            <>
              <Button variant="ghost" disabled={working !== null} onClick={() => setPreview(null)}>
                {t('recovery.back')}
              </Button>
              <Button
                disabled={!evidenceReady || working !== null}
                onClick={() => void applyPreview()}
              >
                {working === 'apply' ? (
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                ) : (
                  <RotateCcw size={13} aria-hidden="true" />
                )}
                {working === 'apply' ? t('recovery.retrying') : t('recovery.apply')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={working !== null} onClick={() => void dismiss()}>
                {t('recovery.continue')}
              </Button>
              {current.kind === 'plugin' && current.notice.retry && (
                <Button
                  disabled={working !== null}
                  onClick={() => setPreview({ kind: 'plugin-retry' })}
                >
                  {t('recovery.retryPreview')}
                </Button>
              )}
              {current.kind === 'profile' && (
                <Button
                  disabled={working !== null}
                  onClick={() => setPreview({ kind: 'profile-retry' })}
                >
                  {t('profileRecovery.retryPreview')}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

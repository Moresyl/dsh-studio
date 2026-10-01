import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  Check,
  Download,
  ExternalLink,
  Layers,
  Loader2,
  Package,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'

import { Badge, type BadgeTone } from '@/components/Badge'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
import { Switch } from '@/components/Switch'
import { count, day, filesize } from '@/lib/format'
import { t } from '@/lib/i18n'
import { pluginDisplayName, pluginVersionAction } from '@/lib/plugin-presentation'
import { normalizeExternalUrl, openExternalUrl } from '@/lib/external-url'
import type { InstalledPlugin, PluginDetail } from '@/lib/ipc'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { useHarness } from '@/state/harness'
import { reportAction } from '@/state/failure'
import { installedPlugin, usePlugins } from '@/state/plugins'

type Verdict = PluginDetail['trust']['level']

/**
 * How a verdict is drawn: the badge that states it, the dot in front of a
 * signal, and the colour its result is set in. One table so the three can never
 * disagree about what "review" looks like.
 */
const VERDICT: Record<Verdict, { tone: BadgeTone; dot: string; text: string }> = {
  verified: { tone: 'ok', dot: 'bg-ok', text: 'text-ok' },
  review: { tone: 'warn', dot: 'bg-warn', text: 'text-warn' },
  blocked: { tone: 'danger', dot: 'bg-danger', text: 'text-danger' },
}

interface PluginDialogProps {
  /** Asked by the pane, so both lists ask the removal question the same way. */
  onRemove: (name: string) => void
}

/**
 * One package, in front of everything else.
 *
 * This used to be a rail down the side of the list, and a rail is the wrong
 * shape for the job. It was 318px of window taken permanently from the list to
 * hold something that is only worth reading about one package at a time, it was
 * empty until something was picked, and the Install button in it sat a long way
 * from the row the eye was actually on. A dialog is none of those: the list gets
 * the whole width back, and the decision arrives where the click happened.
 *
 * What it says has not changed, because the reason the rail existed has not. A
 * registry search for a word returns packages that merely mention the harness
 * beside packages that extend it, and the only honest way to tell them apart is
 * to read the published manifest — which nobody would do by hand before
 * clicking install, and which is cheap to do for them.
 */
export function PluginDialog({ onRemove }: PluginDialogProps) {
  const selected = usePlugins((state) => state.selected)
  const selectedSource = usePlugins((state) => state.selectedSource)
  const selectedVersion = usePlugins((state) => state.selectedVersion)
  const detail = usePlugins((state) => state.detail)
  const loading = usePlugins((state) => state.loadingDetail)
  const previewing = usePlugins((state) => state.previewing)
  const working = usePlugins((state) => state.working)
  const profile = usePlugins((state) => state.profile)
  const results = usePlugins((state) => state.results)
  const select = usePlugins((state) => state.select)
  const add = usePlugins((state) => state.add)
  const preview = usePlugins((state) => state.preview)
  const toggle = usePlugins((state) => state.toggle)

  // The package manager talks while it works, and it talks through the
  // supervisor's log — so the tail of that log is this dialog's progress line.
  const latest = useHarness((state) => state.lines.at(-1)?.line ?? '')

  const card = useRef<HTMLDivElement>(null)
  const primary = useRef<HTMLButtonElement>(null)
  const [reviewing, setReviewing] = useState(false)

  const close = () => {
    setReviewing(false)
    void select(null)
  }

  // Wherever the caret was — a row, the search field — is where it goes back to.
  useEffect(() => {
    const previous = document.activeElement
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  // Capture the opener above before moving focus. Loading, blocked and
  // installed packages may not have an enabled primary action.
  useEffect(() => {
    const target =
      !loading && primary.current && !primary.current.disabled
        ? primary.current
        : card.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    target?.focus()
  }, [loading, selected])

  if (selected === null) return null

  const here = installedPlugin(profile, selected)
  const versionAction = pluginVersionAction(here, detail, selectedSource)
  const listing =
    results.find(
      (result) =>
        result.name === selected &&
        result.sourceId === selectedSource &&
        result.version === selectedVersion,
    ) ?? null
  const busy = working === selected
  const installBlocked =
    detail !== null &&
    (detail.compatibility.state === 'incompatible' ||
      detail.lifecycleScripts.length > 0 ||
      detail.deprecated !== null ||
      !detail.repositoryVerified ||
      !detail.integrityVerified)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => holdFocus(card.current, event, close)
  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => pressedBackdrop(event, close)

  return (
    <div
      role="presentation"
      onMouseDown={onBackdrop}
      onKeyDown={onKeyDown}
      className="dialog-backdrop fixed inset-0 z-40 grid animate-fade place-items-center bg-canvas-deep/65 px-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={t('plugins.details')}
        className="dialog-panel flex max-h-[min(720px,calc(100vh-64px))] w-full max-w-[620px] animate-pop flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lift"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-4">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-brand"
          >
            <Package size={18} strokeWidth={1.8} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="selectable min-w-0 text-ui-lg font-semibold text-text [overflow-wrap:anywhere]">
                {pluginDisplayName(selected)}
              </h2>
              {here && (
                <Badge tone="ok">
                  <Check aria-hidden="true" />
                  {t('plugins.installed')}
                </Badge>
              )}
            </div>
            <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-ui-sm text-muted">
              <span className="selectable [overflow-wrap:anywhere]">{selected}</span>
              {detail && (
                <span className="font-mono text-faint tabular-nums">v{detail.version}</span>
              )}
              {listing?.publisher && (
                <span className="truncate text-faint">{listing.publisher}</span>
              )}
            </p>
          </div>

          <IconButton icon={X} size="sm" label={t('plugins.close')} onClick={close} />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="grid h-[168px] place-items-center">
              <Loader2 size={20} className="animate-spin text-faint" aria-hidden="true" />
            </div>
          ) : detail === null ? (
            <div className="flex h-[168px] flex-col items-center justify-center gap-3 text-center">
              <TriangleAlert
                size={24}
                strokeWidth={1.4}
                className="text-faint opacity-60"
                aria-hidden="true"
              />
              <p className="text-ui-base text-muted">{t('plugins.detailFailed')}</p>
              <Button
                variant="secondary"
                onClick={() =>
                  void select(selected, selectedSource ?? 'npm', selectedVersion ?? 'latest')
                }
              >
                {t('action.recheck')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {detail.description && (
                <p className="selectable text-ui-base text-muted [overflow-wrap:anywhere]">
                  {detail.description}
                </p>
              )}

              {/* The one line that separates a plugin from a package that
                  merely mentions the harness in its description. */}
              <div
                className={[
                  'flex items-start gap-2 rounded-lg border px-3 py-2 text-ui-sm',
                  detail.bundle
                    ? 'border-ok/30 bg-ok/10 text-ok'
                    : 'border-line bg-control-fill text-muted',
                ].join(' ')}
              >
                <Layers
                  size={14}
                  strokeWidth={1.9}
                  className="mt-0.5 shrink-0"
                  aria-hidden="true"
                />
                {detail.bundle ? t('plugins.declaresPatch') : t('plugins.noPatch')}
              </div>

              <section className="card flex flex-col gap-3 px-4 py-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck
                    size={16}
                    strokeWidth={1.9}
                    className={`shrink-0 ${VERDICT[detail.trust.level].text}`}
                    aria-hidden="true"
                  />
                  <h3 className="text-ui-base font-medium text-text">{t('plugins.trust.title')}</h3>
                  <Badge tone={VERDICT[detail.trust.level].tone} className="ml-auto">
                    {detail.trust.level === 'verified'
                      ? t('plugins.trust.verified')
                      : detail.trust.level === 'review'
                        ? t('plugins.trust.review')
                        : t('plugins.trust.blocked')}
                  </Badge>
                </div>

                {/* Two columns only when there is a second signal to put in one:
                    a lone row would leave its verdict stranded mid-card. */}
                {detail.trust.signals.length > 0 && (
                  <ul
                    className={[
                      'grid grid-cols-1 gap-x-6 gap-y-1.5',
                      detail.trust.signals.length > 1 ? 'sm:grid-cols-2' : '',
                    ].join(' ')}
                  >
                    {detail.trust.signals.map((signal) => (
                      <li
                        key={signal.code}
                        data-hint={signal.detail}
                        className="flex items-center gap-2 text-ui-sm"
                      >
                        <span
                          aria-hidden="true"
                          className={`size-1.5 shrink-0 rounded-full ${VERDICT[signal.state].dot}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-muted">
                          {trustSignalLabel(signal.code)}
                        </span>
                        <span className={VERDICT[signal.state].text}>
                          {signal.state === 'verified'
                            ? t('plugins.trust.pass')
                            : signal.state === 'review'
                              ? t('plugins.trust.reviewShort')
                              : t('plugins.trust.stop')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-line pt-3 text-ui-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-faint">{t('plugins.resources.dependencies')}</dt>
                    <dd className="mt-0.5 text-text tabular-nums">
                      {detail.resources.directDependencies}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-faint">{t('plugins.resources.size')}</dt>
                    <dd className="mt-0.5 text-text tabular-nums">
                      {detail.resources.unpackedBytes === null
                        ? t('common.unavailable')
                        : filesize(detail.resources.unpackedBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-faint">{t('plugins.resources.files')}</dt>
                    <dd className="mt-0.5 text-text tabular-nums">
                      {detail.resources.publishedFiles ?? t('common.unavailable')}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-faint">{t('plugins.resources.native')}</dt>
                    <dd
                      className={`mt-0.5 ${detail.resources.nativeBuildDeclared ? 'text-warn' : 'text-ok'}`}
                    >
                      {detail.resources.nativeBuildDeclared
                        ? t('plugins.resources.declared')
                        : t('plugins.resources.none')}
                    </dd>
                  </div>
                </dl>
              </section>

              {(versionAction === 'install' || versionAction === 'replace') && reviewing && (
                <section className="flex flex-col gap-3 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3">
                  <div className="flex items-start gap-2">
                    <ShieldCheck
                      size={16}
                      strokeWidth={1.9}
                      className="mt-0.5 shrink-0 text-warn"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-ui-base font-medium text-text">
                        {t('plugins.review.title')}
                      </h3>
                      <p className="mt-1 text-ui-sm text-muted">{t('plugins.review.warning')}</p>
                    </div>
                  </div>
                  <dl className="grid grid-cols-[112px_1fr] gap-x-3 gap-y-1.5 text-ui-sm">
                    <dt className="text-faint">{t('plugins.review.target')}</dt>
                    <dd className="font-mono break-all text-muted">{detail.installSpec}</dd>
                    <dt className="text-faint">{t('plugins.review.integrity')}</dt>
                    <dd className={detail.integrityVerified ? 'text-ok' : 'text-danger'}>
                      {detail.integrityVerified
                        ? t('plugins.review.verified')
                        : t('plugins.review.blocked')}
                    </dd>
                    <dt className="text-faint">{t('plugins.review.repository')}</dt>
                    <dd className={detail.repositoryVerified ? 'text-ok' : 'text-danger'}>
                      {detail.repositoryVerified
                        ? t('plugins.review.verified')
                        : t('plugins.review.blocked')}
                    </dd>
                    <dt className="text-faint">{t('plugins.review.scripts')}</dt>
                    <dd
                      className={detail.lifecycleScripts.length === 0 ? 'text-ok' : 'text-danger'}
                    >
                      {detail.lifecycleScripts.length === 0
                        ? t('plugins.review.none')
                        : detail.lifecycleScripts.join(', ')}
                    </dd>
                    {detail.deprecated !== null && (
                      <>
                        <dt className="text-faint">{t('plugins.review.deprecated')}</dt>
                        <dd className="text-danger">{detail.deprecated}</dd>
                      </>
                    )}
                  </dl>
                  {installBlocked && (
                    <p className="text-ui-sm text-danger">{t('plugins.review.cannotInstall')}</p>
                  )}
                </section>
              )}

              {here && (
                <ProfileState
                  plugin={here}
                  busy={busy}
                  // Every plugin change writes the same manifest, so while one is
                  // in flight the store refuses the next. The switch says so
                  // rather than accepting a throw that goes nowhere.
                  locked={working !== null && !busy}
                  onToggle={(on) => void toggle(here.name, on)}
                />
              )}

              <dl className="list-card">
                {here && selectedSource !== 'profile' && (
                  <Row label={t('plugins.currentVersion')}>
                    <span className="tabular-nums">
                      {here.installedVersion || here.spec || t('common.unavailable')}
                    </span>
                  </Row>
                )}
                <Row label={t('plugins.source')}>
                  <span className="selectable font-mono text-ui-sm break-all">{detail.source}</span>
                </Row>
                {here?.marketReceipt && (
                  <Row label={t('plugins.receipt')}>
                    <span className="selectable font-mono text-ui-sm break-all">
                      {here.marketReceipt}
                    </span>
                  </Row>
                )}
                <Row label={t('plugins.compatibility')}>
                  <span
                    className={
                      detail.compatibility.state === 'incompatible'
                        ? 'text-danger'
                        : detail.compatibility.state === 'compatible'
                          ? 'text-ok'
                          : 'text-muted'
                    }
                  >
                    {detail.compatibility.state === 'compatible'
                      ? t('plugins.compatible', { range: detail.compatibility.requirement })
                      : detail.compatibility.state === 'incompatible'
                        ? t('plugins.incompatible', { range: detail.compatibility.requirement })
                        : t('plugins.compatibilityUnknown')}
                  </span>
                </Row>
                {detail.license && <Row label={t('plugins.license')}>{detail.license}</Row>}
                {listing && listing.weeklyDownloads > 0 && (
                  <Row label={t('plugins.weekly')}>
                    <span className="tabular-nums">{count(listing.weeklyDownloads)}</span>
                  </Row>
                )}
                {listing?.updated && (
                  <Row label={t('plugins.published')}>
                    <span className="tabular-nums">{day(listing.updated)}</span>
                  </Row>
                )}
                {detail.homepage && (
                  <Row label={t('plugins.homepage')}>
                    <Link href={detail.homepage} />
                  </Row>
                )}
                {detail.repository && (
                  <Row label={t('plugins.repository')}>
                    <Link href={detail.repository} />
                  </Row>
                )}
              </dl>

              {detail.dependencies.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h3 className="caption">{t('plugins.dependencies')}</h3>
                  <ul className="flex flex-wrap gap-1.5">
                    {detail.dependencies.map((dependency) => (
                      <li
                        key={dependency}
                        className="selectable rounded-sm bg-control-fill px-1.5 py-0.5 font-mono text-ui-sm text-muted"
                      >
                        {dependency}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
          {/* While a package manager is running, the footer is where it reports
              — the same tail the pane behind this shows, so closing the dialog
              loses nothing. */}
          <p className="min-w-0 flex-1 truncate font-mono text-ui-sm text-faint">
            {busy ? latest : ''}
          </p>

          <Button variant="secondary" onClick={close}>
            {t('plugins.close')}
          </Button>

          {versionAction === 'manage' && here ? (
            <Button
              ref={primary}
              variant="danger"
              onClick={() => onRemove(selected)}
              // An in-box bundle came with the profile template, so removing it
              // from here would be editing someone else's file behind their
              // back. The panel above says so, where a tooltip on a disabled
              // button could not.
              disabled={working !== null || here.builtin}
            >
              {busy ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 aria-hidden="true" />
              )}
              {busy ? t('plugins.removing') : t('plugins.remove')}
            </Button>
          ) : (
            <Button
              ref={primary}
              variant="primary"
              onClick={() => {
                if (!reviewing) {
                  void preview(detail?.installSpec ?? selected).then((ready) => {
                    if (ready) setReviewing(true)
                  })
                } else {
                  void add().then(() => {
                    // A failed one-shot confirmation must not leave an Install
                    // button backed by a token the native side already used.
                    // The next click starts a fresh, visible review.
                    setReviewing(false)
                  })
                }
              }}
              disabled={
                working !== null ||
                previewing ||
                installBlocked ||
                loading ||
                !detail ||
                versionAction === 'current'
              }
            >
              {busy || previewing ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Download aria-hidden="true" />
              )}
              {versionAction === 'current'
                ? t('plugins.currentVersionReady')
                : busy
                  ? t('plugins.installing')
                  : previewing
                    ? t('plugins.review.previewing')
                    : reviewing
                      ? t('plugins.review.installExact')
                      : t(
                          versionAction === 'replace'
                            ? 'plugins.review.replace'
                            : 'plugins.review.action',
                        )}
            </Button>
          )}
        </footer>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface ProfileStateProps {
  plugin: InstalledPlugin
  busy: boolean
  /** Some other package is being written; this one has to wait its turn. */
  locked: boolean
  onToggle: (on: boolean) => void
}

/**
 * What this package is inside the profile, and the one control that changes it.
 *
 * Installed and in the layer stack are different facts, so this says which, and
 * the switch is only offered where throwing it would mean something: a package
 * that declares no patch has no layer, and the profile template's own bundles
 * are what make the harness a harness.
 */
function ProfileState({ plugin, busy, locked, onToggle }: ProfileStateProps) {
  const layered = plugin.active || plugin.disabled
  const incompatible = plugin.compatibility?.state === 'incompatible'
  const fixed = plugin.builtin || !layered
  const note = plugin.builtin
    ? t('plugins.builtinFixed')
    : !layered
      ? t('plugins.libraryNote')
      : plugin.disabled
        ? t('plugins.offNote')
        : incompatible
          ? t('plugins.runtimeBlockedHint')
          : null
  const status: { tone: BadgeTone; label: string } = plugin.disabled
    ? { tone: 'neutral', label: t('plugins.off') }
    : incompatible
      ? { tone: 'warn', label: t('plugins.runtimeBlocked') }
      : layered
        ? { tone: 'ok', label: t('plugins.on') }
        : { tone: 'neutral', label: t('plugins.library') }

  return (
    <section className="card px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="caption">{t('plugins.inProfile')}</h3>
          <p className="mt-0.5 truncate font-mono text-ui-sm text-muted tabular-nums">
            {plugin.spec || t('plugins.builtin')}
          </p>
        </div>

        <Badge tone={status.tone}>{status.label}</Badge>

        <Switch
          on={!plugin.disabled && layered}
          busy={busy}
          disabled={fixed || locked}
          label={plugin.disabled ? t('plugins.enable') : t('plugins.disable')}
          onChange={onToggle}
        />
      </div>

      {note && <p className="mt-2 text-ui-sm text-faint">{note}</p>}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="list-row">
      <dt className="shrink-0 text-ui-base text-muted">{label}</dt>
      <dd className="ml-auto min-w-0 text-right text-ui-base text-text [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  )
}

/** A published link, opened in the user's own browser rather than in here. */
function Link({ href }: { href: string }) {
  let target: string
  try {
    target = normalizeExternalUrl(href)
  } catch {
    return <span className="text-faint">{t('common.unavailable')}</span>
  }

  // A small ghost button, like every other link in a row. It is 28px inside a
  // 40px row, so its margins give back what the row would otherwise grow by.
  return (
    <Button
      variant="ghost"
      size="sm"
      data-hint={target}
      onClick={() => void reportAction(() => openExternalUrl(target))}
      className="-my-1 -mr-2.5 max-w-full min-w-0"
    >
      <span className="truncate text-text">{target.replace(/^https?:\/\//, '')}</span>
      <ExternalLink aria-hidden="true" />
    </Button>
  )
}

function trustSignalLabel(code: string): string {
  switch (code) {
    case 'harness-compatibility':
      return t('plugins.trust.compatibility')
    case 'registry-integrity':
      return t('plugins.trust.integrity')
    case 'source-identity':
      return t('plugins.trust.identity')
    case 'lifecycle-scripts':
      return t('plugins.trust.lifecycle')
    case 'publisher-status':
      return t('plugins.trust.publisher')
    case 'profile-patch':
      return t('plugins.trust.patch')
    default:
      return code
  }
}

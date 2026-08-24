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
import { openUrl } from '@tauri-apps/plugin-opener'

import { Button } from '@/components/Button'
import { Switch } from '@/components/Switch'
import { count, day } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { InstalledPlugin } from '@/lib/ipc'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { useHarness } from '@/state/harness'
import { installedPlugin, usePlugins } from '@/state/plugins'

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

  // Focus lands on the action, not on the close button: this dialog is opened
  // by pressing Install, and the thing it opened onto should be one Enter away.
  // Deferred until the manifest is in, because until then there is no action.
  useEffect(() => {
    if (!loading) primary.current?.focus()
  }, [loading, selected])

  // Wherever the caret was — a row, the search field — is where it goes back to.
  useEffect(() => {
    const previous = document.activeElement
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  if (selected === null) return null

  const here = installedPlugin(profile, selected)
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
      className="fixed inset-0 z-30 grid animate-fade place-items-center bg-canvas-deep/70 p-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={t('plugins.details')}
        className="flex max-h-full w-full max-w-[540px] animate-pop flex-col overflow-hidden rounded-panel border border-line-strong bg-surface shadow-lift"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3.5">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-[8px] border border-line bg-surface-2 text-brand"
          >
            <Package size={17} strokeWidth={1.9} />
          </span>

          <div className="min-w-0 flex-1 pt-px">
            <h2 className="selectable text-[13px] leading-snug font-semibold break-all text-text">
              {selected}
            </h2>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[11px] text-faint">
              {detail && <span className="font-mono tabular-nums">{detail.version}</span>}
              {listing?.publisher && <span className="truncate">{listing.publisher}</span>}
              {here && (
                <span className="inline-flex items-center gap-1 text-ok">
                  <Check size={10} strokeWidth={2.8} aria-hidden="true" />
                  {t('plugins.installed')}
                </span>
              )}
            </p>
          </div>

          <button
            type="button"
            aria-label={t('plugins.close')}
            data-hint={t('plugins.close')}
            onClick={close}
            className="-mt-0.5 -mr-1 grid size-[26px] shrink-0 place-items-center rounded-control text-faint transition-colors duration-100 hover:bg-surface-2 hover:text-text"
          >
            <X size={14} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <div className="grid h-[168px] place-items-center">
              <Loader2 size={18} className="animate-spin text-faint" aria-hidden="true" />
            </div>
          ) : detail === null ? (
            <div className="flex h-[168px] flex-col items-center justify-center gap-2.5 text-center">
              <TriangleAlert
                size={20}
                strokeWidth={1.5}
                className="text-faint opacity-70"
                aria-hidden="true"
              />
              <p className="text-[12px] text-faint">{t('plugins.detailFailed')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3.5">
              {detail.description && (
                <p className="selectable text-[12px] leading-relaxed text-muted">
                  {detail.description}
                </p>
              )}

              {/* The one line that separates a plugin from a package that
                  merely mentions the harness in its description. */}
              <div
                className={[
                  'flex items-start gap-2 rounded-control border px-2.5 py-2 text-[11.5px] leading-relaxed',
                  detail.bundle
                    ? 'border-ok/25 bg-ok/10 text-ok'
                    : 'border-line bg-surface-2/60 text-muted',
                ].join(' ')}
              >
                <Layers
                  size={12}
                  strokeWidth={2.2}
                  className="mt-[3px] shrink-0"
                  aria-hidden="true"
                />
                {detail.bundle ? t('plugins.declaresPatch') : t('plugins.noPatch')}
              </div>

              {!here && reviewing && (
                <section className="rounded-control border border-warn/35 bg-warn/7 p-3">
                  <div className="flex items-start gap-2">
                    <ShieldCheck
                      size={14}
                      className="mt-0.5 shrink-0 text-warn"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[11.5px] font-medium text-text">
                        {t('plugins.review.title')}
                      </h3>
                      <p className="mt-1 text-[10.5px] leading-relaxed text-muted">
                        {t('plugins.review.warning')}
                      </p>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-[106px_1fr] gap-x-3 gap-y-1.5 text-[10.5px]">
                    <dt className="text-faint">{t('plugins.review.target')}</dt>
                    <dd className="break-all font-mono text-muted">{detail.installSpec}</dd>
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
                    <p className="mt-3 text-[10.5px] leading-relaxed text-danger">
                      {t('plugins.review.cannotInstall')}
                    </p>
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

              <dl className="flex flex-col gap-2 border-t border-line pt-3.5">
                <Row label={t('plugins.source')}>
                  <span className="selectable break-all font-mono text-[10.5px]">
                    {detail.source}
                  </span>
                </Row>
                {here?.marketReceipt && (
                  <Row label={t('plugins.receipt')}>
                    <span className="selectable break-all font-mono text-[10.5px]">
                      {here.marketReceipt}
                    </span>
                  </Row>
                )}
                <Row label={t('plugins.compatibility')}>
                  <span
                    className={
                      detail.compatibility.state === 'incompatible' ? 'text-danger' : 'text-ok'
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
                <div className="flex flex-col gap-1.5 border-t border-line pt-3.5">
                  <h3 className="caption">{t('plugins.dependencies')}</h3>
                  <ul className="flex flex-wrap gap-1">
                    {detail.dependencies.map((dependency) => (
                      <li
                        key={dependency}
                        className="selectable rounded-[4px] border border-line bg-surface-2/60 px-1.5 py-0.5 font-mono text-[10.5px] text-faint"
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

        <footer className="flex shrink-0 items-center gap-3 border-t border-line bg-canvas-deep/40 px-4 py-3">
          {/* While a package manager is running, the footer is where it reports
              — the same tail the pane behind this shows, so closing the dialog
              loses nothing. */}
          <p className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">
            {busy ? latest : ''}
          </p>

          <Button variant="secondary" onClick={close}>
            {t('plugins.close')}
          </Button>

          {here ? (
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
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} strokeWidth={2.2} />
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
                  void add().then((installed) => {
                    // A failed one-shot confirmation must not leave an Install
                    // button backed by a token the native side already used.
                    // The next click starts a fresh, visible review.
                    if (!installed) setReviewing(false)
                  })
                }
              }}
              disabled={working !== null || previewing || installBlocked}
            >
              {busy || previewing ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} strokeWidth={2.3} />
              )}
              {busy
                ? t('plugins.installing')
                : previewing
                  ? t('plugins.review.previewing')
                  : reviewing
                    ? t('plugins.review.installExact')
                    : t('plugins.review.action')}
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
  const fixed = plugin.builtin || !layered
  const note = plugin.builtin
    ? t('plugins.builtinFixed')
    : !layered
      ? t('plugins.libraryNote')
      : plugin.disabled
        ? t('plugins.offNote')
        : null

  return (
    <section className="rounded-control border border-line bg-canvas-deep/55 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="caption">{t('plugins.inProfile')}</h3>
          <p className="mt-1 truncate font-mono text-[11px] text-muted tabular-nums">
            {plugin.spec || t('plugins.builtin')}
          </p>
        </div>

        <span
          className={[
            'text-[11.5px] font-medium',
            plugin.disabled ? 'text-faint' : layered ? 'text-ok' : 'text-faint',
          ].join(' ')}
        >
          {layered ? (plugin.disabled ? t('plugins.off') : t('plugins.on')) : t('plugins.library')}
        </span>

        <Switch
          on={!plugin.disabled && layered}
          busy={busy}
          disabled={fixed || locked}
          label={plugin.disabled ? t('plugins.enable') : t('plugins.disable')}
          onChange={onToggle}
        />
      </div>

      {note && <p className="mt-2 text-[11px] leading-relaxed text-faint">{note}</p>}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="shrink-0 text-[11.5px] text-faint">{label}</dt>
      <dd className="ml-auto min-w-0 truncate text-right text-[11.5px] text-muted">{children}</dd>
    </div>
  )
}

/** A published link, opened in the user's own browser rather than in here. */
function Link({ href }: { href: string }) {
  const target = href.replace(/^git\+/, '').replace(/\.git$/, '')

  return (
    <button
      type="button"
      data-hint={target}
      onClick={() => void openUrl(target)}
      className="inline-flex max-w-full items-center gap-1 transition-colors duration-100 hover:text-brand"
    >
      <span className="truncate">{target.replace(/^https?:\/\//, '')}</span>
      <ExternalLink size={10} strokeWidth={2.2} className="shrink-0" aria-hidden="true" />
    </button>
  )
}

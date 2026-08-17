import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Check,
  Download,
  ExternalLink,
  Info,
  Layers,
  Loader2,
  Package,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'

import { Button } from '@/components/Button'
import { PaneHeader } from '@/components/PaneHeader'
import { t } from '@/lib/i18n'
import type { InstalledPlugin, PluginDetail, PluginListing } from '@/lib/ipc'
import { ask } from '@/state/dialog'
import { useHarness } from '@/state/harness'
import { isInstalled, usePlugins } from '@/state/plugins'

/** Long enough that typing a scoped name is one request, short enough to feel live. */
const DEBOUNCE = 320

type Tab = 'discover' | 'installed'

/**
 * The plugin marketplace.
 *
 * A plugin here is an ordinary npm package that declares a profile patch, which
 * has two consequences the pane is built around. The first is that discovery is
 * a registry search rather than a curated list — nobody has to be approved into
 * this, and this project does not get to decide whose plugin is worth seeing.
 * The second is that "installed" and "in the layer stack" are different facts: a
 * package can be a dependency of the profile without patching it, and a list
 * that conflated the two would explain nothing on the day one of them is a
 * plain library.
 *
 * Changes go through the harness's own plugin command, so the pane never claims
 * a result it did not get back from disk. What it does add is the sentence
 * nobody would otherwise be told: the layer stack is composed at startup, so a
 * change is written now and in effect at the next start.
 */
export function PluginMarket() {
  const profile = usePlugins((state) => state.profile)
  const results = usePlugins((state) => state.results)
  const selected = usePlugins((state) => state.selected)
  const detail = usePlugins((state) => state.detail)
  const searching = usePlugins((state) => state.searching)
  const loadingDetail = usePlugins((state) => state.loadingDetail)
  const working = usePlugins((state) => state.working)
  const error = usePlugins((state) => state.error)
  const refresh = usePlugins((state) => state.refresh)
  const search = usePlugins((state) => state.search)
  const select = usePlugins((state) => state.select)
  const add = usePlugins((state) => state.add)
  const remove = usePlugins((state) => state.remove)

  const [tab, setTab] = useState<Tab>('discover')
  const [query, setQuery] = useState('')
  const field = useRef<HTMLInputElement>(null)

  // Asked here rather than at each button: both lists remove a plugin the same
  // way, and a question whose wording depends on which list you happened to be
  // looking at is a question with two answers.
  const confirmRemove = useCallback(
    async (name: string) => {
      const taken = await ask({
        title: t('plugins.confirmRemove'),
        body: t('plugins.confirmRemoveBody'),
        subject: name,
        confirm: t('plugins.remove'),
      })
      if (taken) await remove(name)
    },
    [remove],
  )

  // The package manager talks while it works, and it talks through the
  // supervisor's log — so the tail of that log is this pane's progress bar.
  const latest = useHarness((state) => state.lines.at(-1)?.line ?? '')

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The empty query is what fills the pane on arrival, so it runs immediately;
  // everything after it is somebody typing.
  useEffect(() => {
    const timer = window.setTimeout(() => void search(query), query === '' ? 0 : DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [query, search])

  const installed = profile?.plugins ?? []
  const removable = installed.filter((plugin) => !plugin.builtin).length

  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col">
      <PaneHeader
        title={t('plugins.title')}
        subtitle={t('plugins.subtitle', { profile: profile?.profile ?? '' })}
        subtitleTitle={profile?.profileDir}
      >
        <div className="flex items-center gap-0.5 rounded-control bg-canvas-deep p-0.5 hairline">
          <TabButton
            label={t('plugins.tab.discover')}
            active={tab === 'discover'}
            onClick={() => setTab('discover')}
          />
          <TabButton
            label={
              removable > 0
                ? `${t('plugins.tab.installed')} ${removable}`
                : t('plugins.tab.installed')
            }
            active={tab === 'installed'}
            onClick={() => setTab('installed')}
          />
        </div>
      </PaneHeader>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col bg-canvas">
          {tab === 'discover' && (
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
              <Search
                size={14}
                strokeWidth={2.1}
                className="shrink-0 text-faint"
                aria-hidden="true"
              />
              <input
                ref={field}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                // Escape empties a search field on every platform, and does it
                // without taking the caret out of the field.
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query !== '') {
                    event.stopPropagation()
                    setQuery('')
                  }
                }}
                placeholder={t('plugins.search')}
                spellCheck={false}
                autoComplete="off"
                className="selectable h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-faint"
              />
              {searching && (
                <Loader2
                  size={13}
                  className="shrink-0 animate-spin text-faint"
                  aria-hidden="true"
                />
              )}
              {/* The browser's own clear button is hidden, so here is one that
                  matches the rest of the window — and clearing puts the caret
                  back where the typing was. */}
              {query !== '' && !searching && (
                <button
                  type="button"
                  title={t('plugins.clearSearch')}
                  aria-label={t('plugins.clearSearch')}
                  onClick={() => {
                    setQuery('')
                    field.current?.focus()
                  }}
                  className="grid size-[17px] shrink-0 place-items-center rounded-full text-faint transition-colors duration-100 hover:bg-surface-2 hover:text-text"
                >
                  <X size={11} strokeWidth={2.4} aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {profile && !profile.packageManager && (
            <Notice tone="warn" icon={TriangleAlert}>
              {t('plugins.bootstrap')}
            </Notice>
          )}

          {error && (
            <Notice tone="danger" icon={TriangleAlert}>
              {error}
            </Notice>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'discover' ? (
              <Discover
                results={results}
                searching={searching}
                selected={selected}
                busy={working !== null}
                onSelect={(name) => void select(name)}
                onInstall={(spec) => void add(spec)}
                isInstalled={(name) => isInstalled(profile, name)}
                working={working}
              />
            ) : (
              <Installed
                plugins={installed}
                initialized={profile?.initialized ?? false}
                working={working}
                onRemove={(name) => void confirmRemove(name)}
              />
            )}
          </div>

          {working !== null && (
            <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-canvas-deep px-4">
              <Loader2 size={12} className="shrink-0 animate-spin text-brand" aria-hidden="true" />
              <span className="truncate font-mono text-[11px] text-muted">{latest || working}</span>
            </div>
          )}

          <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-line px-4">
            <Info size={12} strokeWidth={2} className="shrink-0 text-faint" aria-hidden="true" />
            <p className="truncate text-[11.5px] text-faint">{t('plugins.restart')}</p>
          </footer>
        </div>

        {tab === 'discover' && (
          <Detail
            detail={detail}
            selected={selected}
            loading={loadingDetail}
            installed={selected !== null && isInstalled(profile, selected)}
            working={working}
            onInstall={(spec) => void add(spec)}
            onRemove={(name) => void confirmRemove(name)}
          />
        )}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */

interface DiscoverProps {
  results: PluginListing[]
  searching: boolean
  selected: string | null
  busy: boolean
  working: string | null
  onSelect: (name: string) => void
  onInstall: (spec: string) => void
  isInstalled: (name: string) => boolean
}

function Discover({
  results,
  searching,
  selected,
  busy,
  working,
  onSelect,
  onInstall,
  isInstalled,
}: DiscoverProps) {
  if (results.length === 0) {
    return (
      <Empty icon={Package} message={searching ? t('plugins.searching') : t('plugins.noResults')} />
    )
  }

  return (
    <ul>
      {results.map((listing) => {
        const here = isInstalled(listing.name)

        return (
          <li key={listing.name}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(listing.name)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(listing.name)
                }
              }}
              className={[
                'relative flex w-full cursor-default items-start gap-3 border-b border-line px-4 py-3 text-left transition-colors duration-100',
                selected === listing.name ? 'bg-surface-2' : 'hover:bg-surface-2/55',
              ].join(' ')}
            >
              {selected === listing.name && (
                <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-brand" />
              )}

              <Tile />

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[12.5px] font-medium text-text">
                    {listing.name}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
                    {listing.version}
                  </span>
                </div>

                {listing.description && (
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted">
                    {listing.description}
                  </p>
                )}

                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
                  {listing.publisher && <span className="truncate">{listing.publisher}</span>}
                  {listing.weeklyDownloads > 0 && (
                    <span className="tabular-nums">
                      {t('plugins.downloads', { count: count(listing.weeklyDownloads) })}
                    </span>
                  )}
                  {listing.updated && (
                    <span className="tabular-nums">
                      {t('plugins.updated', { date: day(listing.updated) })}
                    </span>
                  )}
                </div>
              </div>

              <RowAction
                installed={here}
                busy={working === listing.name}
                disabled={busy}
                onInstall={(event) => {
                  event.stopPropagation()
                  onInstall(listing.name)
                }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function RowAction({
  installed,
  busy,
  disabled,
  onInstall,
}: {
  installed: boolean
  busy: boolean
  disabled: boolean
  onInstall: (event: MouseEvent) => void
}) {
  if (installed) {
    return (
      <span className="mt-0.5 inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[4px] px-2 text-[11.5px] font-medium text-ok">
        <Check size={11} strokeWidth={2.6} aria-hidden="true" />
        {t('plugins.installed')}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onInstall}
      disabled={disabled}
      className="mt-0.5 inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[4px] border border-line-strong bg-surface-2 px-2 text-[11.5px] font-medium text-text transition duration-100 hover:brightness-[1.2] disabled:pointer-events-none disabled:opacity-45"
    >
      {busy ? (
        <Loader2 size={11} className="animate-spin" aria-hidden="true" />
      ) : (
        <Download size={11} strokeWidth={2.4} aria-hidden="true" />
      )}
      {busy ? t('plugins.installing') : t('plugins.install')}
    </button>
  )
}

/* -------------------------------------------------------------------------- */

interface InstalledProps {
  plugins: InstalledPlugin[]
  initialized: boolean
  working: string | null
  onRemove: (name: string) => void
}

function Installed({ plugins, initialized, working, onRemove }: InstalledProps) {
  if (plugins.length === 0) {
    return (
      <Empty
        icon={Layers}
        message={initialized ? t('plugins.noneInstalled') : t('plugins.uninitialized')}
      />
    )
  }

  return (
    <ul>
      {plugins.map((plugin) => (
        <li
          key={plugin.name}
          className="flex items-center gap-3 border-b border-line px-4 py-2.5"
          title={plugin.name}
        >
          <Tile muted={plugin.builtin} />

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-[12.5px] font-medium text-text">{plugin.name}</span>
              {plugin.spec && (
                <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
                  {plugin.spec}
                </span>
              )}
            </div>

            <div className="mt-1 flex items-center gap-1.5">
              <Badge tone={plugin.active ? 'ok' : 'faint'}>
                {plugin.active ? t('plugins.layer') : t('plugins.library')}
              </Badge>
              {plugin.builtin && <Badge tone="faint">{t('plugins.builtin')}</Badge>}
            </div>
          </div>

          {/* An in-box bundle came with the profile template, so removing it
              from here would be editing someone else's file behind their back. */}
          {!plugin.builtin && (
            <button
              type="button"
              onClick={() => onRemove(plugin.name)}
              disabled={working !== null}
              className="inline-flex h-[24px] shrink-0 items-center gap-1 rounded-[4px] border border-line-strong bg-surface-2 px-2 text-[11.5px] font-medium text-muted transition duration-100 hover:border-danger/40 hover:text-danger disabled:pointer-events-none disabled:opacity-45"
            >
              {working === plugin.name ? (
                <Loader2 size={11} className="animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 size={11} strokeWidth={2.2} aria-hidden="true" />
              )}
              {working === plugin.name ? t('plugins.removing') : t('plugins.remove')}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

/* -------------------------------------------------------------------------- */

interface DetailProps {
  detail: PluginDetail | null
  selected: string | null
  loading: boolean
  installed: boolean
  working: string | null
  onInstall: (spec: string) => void
  onRemove: (name: string) => void
}

/**
 * What one package actually declares.
 *
 * The patch line is the reason this rail exists. A registry search for a word
 * returns packages that merely mention the harness alongside packages that
 * extend it, and the only honest way to tell them apart is to read the published
 * manifest — which is cheap, and which nobody would do by hand before clicking
 * install.
 */
function Detail({
  detail,
  selected,
  loading,
  installed,
  working,
  onInstall,
  onRemove,
}: DetailProps) {
  return (
    <aside className="flex w-[318px] shrink-0 flex-col overflow-y-auto border-l border-line bg-canvas-deep/45">
      {selected === null ? (
        <Empty icon={Package} message={t('plugins.pick')} />
      ) : loading ? (
        <div className="grid flex-1 place-items-center">
          <Loader2 size={18} className="animate-spin text-faint" aria-hidden="true" />
        </div>
      ) : detail === null ? (
        <Empty icon={TriangleAlert} message={t('plugins.detailFailed')} />
      ) : (
        <div className="flex flex-col gap-4 p-4">
          <div className="flex flex-col gap-1.5">
            <h3 className="selectable text-[13px] leading-snug font-semibold break-all text-text">
              {detail.name}
            </h3>
            <span className="font-mono text-[11.5px] text-faint tabular-nums">
              {detail.version}
            </span>
            {detail.description && (
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{detail.description}</p>
            )}
          </div>

          <div
            className={[
              'flex items-start gap-2 rounded-control border px-2.5 py-2 text-[11.5px] leading-relaxed',
              detail.bundle
                ? 'border-ok/25 bg-ok/10 text-ok'
                : 'border-line bg-surface-2/60 text-muted',
            ].join(' ')}
          >
            <Layers size={12} strokeWidth={2.2} className="mt-[3px] shrink-0" aria-hidden="true" />
            {detail.bundle ? t('plugins.declaresPatch') : t('plugins.noPatch')}
          </div>

          {installed ? (
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => onRemove(detail.name)}
              disabled={working !== null}
            >
              {working === detail.name ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} strokeWidth={2.2} />
              )}
              {working === detail.name ? t('plugins.removing') : t('plugins.remove')}
            </Button>
          ) : (
            <Button
              variant="primary"
              className="w-full"
              onClick={() => onInstall(detail.name)}
              disabled={working !== null}
            >
              {working === detail.name ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Download size={13} strokeWidth={2.3} />
              )}
              {working === detail.name ? t('plugins.installing') : t('plugins.install')}
            </Button>
          )}

          <dl className="flex flex-col gap-2">
            {detail.license && <Row label={t('plugins.license')}>{detail.license}</Row>}
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
            <div className="flex flex-col gap-1.5">
              <h4 className="caption">{t('plugins.dependencies')}</h4>
              <ul className="flex flex-wrap gap-1">
                {detail.dependencies.map((dependency) => (
                  <li
                    key={dependency}
                    className="rounded-[4px] border border-line bg-surface-2/60 px-1.5 py-0.5 font-mono text-[10.5px] text-faint"
                  >
                    {dependency}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
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
      title={target}
      onClick={() => void openUrl(target)}
      className="inline-flex max-w-full items-center gap-1 transition-colors duration-100 hover:text-brand"
    >
      <span className="truncate">{target.replace(/^https?:\/\//, '')}</span>
      <ExternalLink size={10} strokeWidth={2.2} className="shrink-0" aria-hidden="true" />
    </button>
  )
}

/* -------------------------------------------------------------------------- */

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={active ? undefined : onClick}
      className={[
        'h-[22px] rounded-[3px] px-2.5 text-[11.5px] transition-colors duration-100',
        active ? 'bg-surface-2 text-text shadow-panel' : 'text-faint hover:text-muted',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

function Tile({ muted = false }: { muted?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'mt-0.5 grid size-8 shrink-0 place-items-center rounded-[7px] border border-line',
        muted ? 'bg-surface-2/50 text-faint' : 'bg-surface-2 text-brand',
      ].join(' ')}
    >
      <Package size={15} strokeWidth={1.9} />
    </span>
  )
}

function Badge({ tone, children }: { tone: 'ok' | 'faint'; children: ReactNode }) {
  return (
    <span
      className={[
        'rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium',
        tone === 'ok' ? 'bg-ok/15 text-ok' : 'bg-surface-2 text-faint',
      ].join(' ')}
    >
      {children}
    </span>
  )
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'warn' | 'danger'
  icon: typeof TriangleAlert
  children: ReactNode
}) {
  return (
    <div
      className={[
        'flex shrink-0 items-start gap-2 border-b px-4 py-2',
        tone === 'warn' ? 'border-line bg-warn/10' : 'border-danger/25 bg-danger/10',
      ].join(' ')}
    >
      <Icon
        size={13}
        strokeWidth={2.1}
        className={`mt-[2px] shrink-0 ${tone === 'warn' ? 'text-warn' : 'text-danger'}`}
        aria-hidden="true"
      />
      <p className="selectable text-[11.5px] leading-relaxed text-muted">{children}</p>
    </div>
  )
}

function Empty({ icon: Icon, message }: { icon: typeof Package; message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 py-12 text-center">
      <Icon size={22} strokeWidth={1.4} className="text-faint opacity-60" aria-hidden="true" />
      <p className="text-[12px] text-faint">{message}</p>
    </div>
  )
}

/** Compact enough for a metadata line: 12,400 becomes 12.4k. */
const count = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value)

/** The publish date, in whatever order the user's locale writes one. */
const day = (iso: string): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

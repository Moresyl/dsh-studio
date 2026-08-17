import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Check,
  Download,
  Info,
  Layers,
  Loader2,
  Package,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'

import { PaneHeader } from '@/components/PaneHeader'
import { PluginDialog } from '@/components/PluginDialog'
import { Switch } from '@/components/Switch'
import { count, day } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { InstalledPlugin, PluginListing } from '@/lib/ipc'
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
 * package can be a dependency of the profile without patching it, one that does
 * patch it can be switched off without being uninstalled, and a list that
 * flattened the three into "installed" would explain nothing on the day one of
 * them is the reason something is not loading.
 *
 * So the pane is one wide list and nothing else. What a package declares is
 * worth a paragraph and a set of links, and a paragraph belongs in front of
 * someone who asked for it rather than in a rail that takes a third of the
 * window whether or not anything is selected.
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
  const searching = usePlugins((state) => state.searching)
  const working = usePlugins((state) => state.working)
  const error = usePlugins((state) => state.error)
  const refresh = usePlugins((state) => state.refresh)
  const search = usePlugins((state) => state.search)
  const select = usePlugins((state) => state.select)
  const remove = usePlugins((state) => state.remove)
  const toggle = usePlugins((state) => state.toggle)

  const [tab, setTab] = useState<Tab>('discover')
  const [query, setQuery] = useState('')
  const field = useRef<HTMLInputElement>(null)

  // Asked here rather than at each button: all three places remove a plugin the
  // same way, and a question whose wording depends on which list you happened
  // to be looking at is a question with two answers.
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
    <>
      <section className="flex min-h-0 flex-1 animate-rise flex-col bg-canvas">
        <PaneHeader
          title={t('plugins.title')}
          subtitle={t('plugins.subtitle', { profile: profile?.profile ?? '' })}
          subtitleHint={profile?.profileDir}
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
              <Loader2 size={13} className="shrink-0 animate-spin text-faint" aria-hidden="true" />
            )}
            {/* The browser's own clear button is hidden, so here is one that
                matches the rest of the window — and clearing puts the caret
                back where the typing was. */}
            {query !== '' && !searching && (
              <button
                type="button"
                data-hint={t('action.clearSearch')}
                aria-label={t('action.clearSearch')}
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
              working={working}
              onOpen={(name) => void select(name)}
              isInstalled={(name) => isInstalled(profile, name)}
            />
          ) : (
            <Installed
              plugins={installed}
              initialized={profile?.initialized ?? false}
              working={working}
              onOpen={(name) => void select(name)}
              onToggle={(name, on) => void toggle(name, on)}
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
      </section>

      {/* Outside the pane rather than inside it: the pane plays a transform on
          arrival, and a transform is a containing block for anything fixed
          within it. */}
      {selected !== null && <PluginDialog onRemove={confirmRemove} />}
    </>
  )
}

/* -------------------------------------------------------------------------- */

interface DiscoverProps {
  results: PluginListing[]
  searching: boolean
  selected: string | null
  working: string | null
  onOpen: (name: string) => void
  isInstalled: (name: string) => boolean
}

function Discover({ results, searching, selected, working, onOpen, isInstalled }: DiscoverProps) {
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
              onClick={() => onOpen(listing.name)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen(listing.name)
                }
              }}
              className={[
                'relative flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left transition-colors duration-100',
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

              {/* Both this and the row itself open the same dialog. The button
                  is there because "install" is what the visitor came to do, and
                  a list that only reacts to being clicked somewhere vague makes
                  them guess where. */}
              <RowAction
                installed={here}
                busy={working === listing.name}
                onOpen={(event) => {
                  event.stopPropagation()
                  onOpen(listing.name)
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
  onOpen,
}: {
  installed: boolean
  busy: boolean
  onOpen: (event: MouseEvent) => void
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
      onClick={onOpen}
      className="mt-0.5 inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[4px] border border-line-strong bg-surface-2 px-2 text-[11.5px] font-medium text-text transition duration-100 enabled:hover:brightness-[1.2] enabled:active:brightness-95"
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
  onOpen: (name: string) => void
  onToggle: (name: string, on: boolean) => void
  onRemove: (name: string) => void
}

function Installed({ plugins, initialized, working, onOpen, onToggle, onRemove }: InstalledProps) {
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
      {plugins.map((plugin) => {
        // In the stack or taken out of it — either way there is a layer here to
        // switch. A package that declares no patch has none, and offering a
        // switch for it would promise something the harness would undo.
        const layered = plugin.active || plugin.disabled
        const busy = working === plugin.name

        return (
          <li
            key={plugin.name}
            className="flex items-center gap-3 border-b border-line px-4 py-2.5"
          >
            <Tile muted={plugin.builtin || plugin.disabled} />

            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => onOpen(plugin.name)}
                data-hint={plugin.name}
                className="flex max-w-full items-baseline gap-2 text-left"
              >
                <span
                  className={[
                    'truncate text-[12.5px] font-medium transition-colors duration-100 hover:text-brand',
                    plugin.disabled ? 'text-muted' : 'text-text',
                  ].join(' ')}
                >
                  {plugin.name}
                </span>
                {plugin.spec && (
                  <span className="shrink-0 font-mono text-[11px] text-faint tabular-nums">
                    {plugin.spec}
                  </span>
                )}
              </button>

              <div className="mt-1 flex items-center gap-1.5">
                {plugin.disabled ? (
                  <Badge tone="faint">{t('plugins.off')}</Badge>
                ) : (
                  <Badge tone={plugin.active ? 'ok' : 'faint'}>
                    {plugin.active ? t('plugins.layer') : t('plugins.library')}
                  </Badge>
                )}
                {plugin.builtin && <Badge tone="faint">{t('plugins.builtin')}</Badge>}
              </div>
            </div>

            {/* The reversible change sits before the one that is not, and the
                profile template's own bundles get neither: switching one off
                would leave a running harness with no interface. */}
            {layered && !plugin.builtin && (
              <Switch
                on={!plugin.disabled}
                busy={busy}
                disabled={working !== null && !busy}
                label={plugin.disabled ? t('plugins.enable') : t('plugins.disable')}
                onChange={(on) => onToggle(plugin.name, on)}
              />
            )}

            {!plugin.builtin && (
              <button
                type="button"
                data-hint={t('plugins.remove')}
                aria-label={t('plugins.remove')}
                onClick={() => onRemove(plugin.name)}
                disabled={working !== null}
                className="grid size-[26px] shrink-0 place-items-center rounded-control border border-line-strong bg-surface-2 text-muted transition duration-100 enabled:hover:border-danger/40 enabled:hover:text-danger enabled:active:brightness-95 disabled:opacity-45"
              >
                <Trash2 size={12} strokeWidth={2.2} aria-hidden="true" />
              </button>
            )}
          </li>
        )
      })}
    </ul>
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
        active
          ? 'cursor-default bg-surface-2 text-text shadow-panel'
          : 'text-faint hover:bg-surface-2/60 hover:text-text',
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

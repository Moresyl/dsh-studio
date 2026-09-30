import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { open as pickFile } from '@tauri-apps/plugin-dialog'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  Info,
  Layers,
  Loader2,
  Package,
  PackagePlus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'

import { Badge } from '@/components/Badge'
import { Button, buttonClass } from '@/components/Button'
import { Empty } from '@/components/Empty'
import { IconButton } from '@/components/IconButton'
import { PaneHeader } from '@/components/PaneHeader'
import { PluginDialog } from '@/components/PluginDialog'
import { CatalogSourcesDialog } from '@/components/CatalogSourcesDialog'
import { Segmented, type SegmentedItem } from '@/components/Segmented'
import { SelectControl } from '@/components/SelectControl'
import { Switch } from '@/components/Switch'
import { count, filesize } from '@/lib/format'
import { t } from '@/lib/i18n'
import { pluginDisplayName } from '@/lib/plugin-presentation'
import { openExternalUrl } from '@/lib/external-url'
import * as ipc from '@/lib/ipc'
import type { CatalogSource, InstalledPlugin, PluginListing, PluginSort } from '@/lib/ipc'
import { ask } from '@/state/dialog'
import { reportAction } from '@/state/failure'
import { useHarness } from '@/state/harness'
import { isInstalled, usePlugins } from '@/state/plugins'

/** Long enough that typing a scoped name is one request, short enough to feel live. */
const DEBOUNCE = 320
const ICONS = new Map<string, string | null>()
const DSH_HUB = 'https://dsh-hub.org/'

type Tab = 'discover' | 'installable' | 'installed' | 'sources'

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
 * Discovery uses responsive cards with a short summary. The exact package
 * identity remains visible; dependency and trust details open on request.
 *
 * Changes go through the harness's own plugin command, so the pane never claims
 * a result it did not get back from disk. What it does add is the sentence
 * nobody would otherwise be told: the layer stack is composed at startup, so a
 * change is written now and in effect at the next start.
 */
export function PluginMarket() {
  const profile = usePlugins((state) => state.profile)
  const results = usePlugins((state) => state.results)
  const categories = usePlugins((state) => state.categories)
  const total = usePlugins((state) => state.total)
  const landedPage = usePlugins((state) => state.page)
  const pageSize = usePlugins((state) => state.pageSize)
  const hasMore = usePlugins((state) => state.hasMore)
  const sources = usePlugins((state) => state.sources)
  const selected = usePlugins((state) => state.selected)
  const searching = usePlugins((state) => state.searching)
  const sourceWorking = usePlugins((state) => state.sourceWorking)
  const working = usePlugins((state) => state.working)
  const error = usePlugins((state) => state.error)
  const refresh = usePlugins((state) => state.refresh)
  const search = usePlugins((state) => state.search)
  const select = usePlugins((state) => state.select)
  const selectInstalled = usePlugins((state) => state.selectInstalled)
  const selectSource = usePlugins((state) => state.selectSource)
  const remove = usePlugins((state) => state.remove)
  const toggle = usePlugins((state) => state.toggle)
  const inspect = usePlugins((state) => state.inspect)
  const bringIn = usePlugins((state) => state.bringIn)

  const [tab, setTab] = useState<Tab>('discover')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [sort, setSort] = useState<PluginSort>('relevance')
  const [page, setPage] = useState(0)
  const [managingSources, setManagingSources] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const resultsViewport = useRef<HTMLDivElement>(null)
  const activeSource = sources.find((source) => source.active) ?? null

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

  // Installing a plugin nobody can download.
  //
  // The search above this needs a route to the registry, and the machines that
  // most want a plugin system are often the ones with no route to anything. So
  // the other way in is a file: an npm tarball, which is what the registry
  // serves and what `npm pack` writes, carried in on whatever the site allows.
  //
  // Read before installed, for the same reason a profile import is. A file name
  // is whatever the person who sent it typed; the package inside it is the thing
  // about to be added to this profile, and it is the one worth confirming.
  const importArchive = useCallback(async () => {
    const path = await reportAction(
      async () =>
        await pickFile({
          title: t('plugins.importTitle'),
          filters: [{ name: t('plugins.importKind'), extensions: ['tgz', 'gz'] }],
        }),
    )
    if (typeof path !== 'string') return

    const archive = await inspect(path)
    if (!archive) return

    const taken = await ask({
      title: t('plugins.confirmImport'),
      // A package that patches nothing is still worth installing on a machine
      // with no registry — it may be what a plugin depends on — but somebody who
      // picked it expecting a plugin should be told before, not after.
      body: archive.bundle
        ? t('plugins.confirmImportBody', { size: filesize(archive.bytes) })
        : t('plugins.confirmImportLibrary', { size: filesize(archive.bytes) }),
      subject: `${archive.name} ${archive.version}`.trim(),
      confirm: t('plugins.install'),
      tone: 'brand',
    })
    if (taken) await bringIn(archive)
  }, [inspect, bringIn])

  // The package manager talks while it works, and it talks through the
  // supervisor's log — so the tail of that log is this pane's progress bar.
  const latest = useHarness((state) => state.lines.at(-1)?.line ?? '')

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The empty query is what fills the pane on arrival, so it runs immediately;
  // everything after it is somebody typing.
  useEffect(() => {
    if (tab === 'installed' || tab === 'sources') return
    const timer = window.setTimeout(
      () => void search(query, category, sort, page, false, tab === 'installable'),
      query === '' ? 0 : DEBOUNCE,
    )
    return () => window.clearTimeout(timer)
  }, [query, category, sort, page, search, activeSource?.id, tab, profile])

  useEffect(() => {
    resultsViewport.current?.scrollTo({ top: 0 })
  }, [results, tab])

  const installed = profile?.plugins ?? []
  const removable = installed.filter((plugin) => !plugin.builtin).length
  const registryView = tab === 'discover' || tab === 'installable'

  const tabs: SegmentedItem<Tab>[] = [
    { value: 'discover', label: t('plugins.tab.discover') },
    { value: 'installable', label: t('plugins.tab.installable') },
    {
      value: 'installed',
      label: t('plugins.tab.installed'),
      // Inherits the segment's ink, so the count stays legible on the raised
      // inverse segment as well as on the track.
      trailing:
        removable > 0 ? (
          <span className="text-ui-xs tabular-nums opacity-70">{removable}</span>
        ) : undefined,
    },
    { value: 'sources', label: t('plugins.tab.sources') },
  ]

  return (
    <>
      <section className="flex min-h-0 flex-1 animate-rise flex-col bg-canvas">
        <PaneHeader
          title={t('plugins.title')}
          subtitle={t('plugins.subtitle', { profile: profile?.profile ?? '' })}
          subtitleHint={profile?.profileDir}
        >
          <Segmented
            size="md"
            label={t('plugins.title')}
            items={tabs}
            value={tab}
            onChange={(next) => {
              setTab(next)
              // The two registry views page; the other two have no pages to reset.
              if (next === 'discover' || next === 'installable') setPage(0)
            }}
          />

          {/* Beside the tabs rather than inside either one: this installs, so it
              belongs with discovery, but it is the only way in on a machine
              where discovery finds nothing at all. */}
          <Button
            variant="secondary"
            onClick={() => void importArchive()}
            disabled={working !== null}
            data-hint={t('plugins.importHint')}
          >
            <PackagePlus aria-hidden="true" />
            {t('plugins.import')}
          </Button>
        </PaneHeader>

        <div className="@container mx-auto mb-6 flex min-h-0 w-[calc(100%-48px)] max-w-[1040px] flex-1 flex-col">
          {registryView && (
            <div className="flex shrink-0 flex-col gap-3 pb-4">
              {/* One toolbar: where to look, how to manage where, and what for.
                  All three are the default control height so the row reads as a
                  single strip rather than a field with things pinned inside it. */}
              <div className="flex items-center gap-2">
                <SelectControl
                  value={activeSource?.id ?? 'npm'}
                  disabled={working !== null || sourceWorking}
                  onValueChange={(value) => {
                    setCategory(null)
                    setPage(0)
                    void selectSource(value)
                  }}
                  aria-label={t('plugins.source')}
                  containerClassName="w-44 shrink-0"
                >
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.label}
                    </option>
                  ))}
                </SelectControl>
                <IconButton
                  icon={Settings2}
                  size="md"
                  label={t('plugins.sources.manage')}
                  onClick={() => setManagingSources(true)}
                  disabled={working !== null || sourceWorking}
                />
                <label className="field-shell min-w-0 flex-1">
                  <Search size={16} strokeWidth={1.9} aria-hidden="true" />
                  <input
                    ref={field}
                    aria-label={t('plugins.search')}
                    type="search"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setPage(0)
                    }}
                    // Escape empties a search field on every platform, and does it
                    // without taking the caret out of the field.
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && query !== '') {
                        event.stopPropagation()
                        setQuery('')
                        setPage(0)
                      }
                    }}
                    placeholder={t('plugins.search')}
                    spellCheck={false}
                    autoComplete="off"
                    className="selectable"
                  />
                  {searching && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                  {/* The browser's own clear button is hidden, so here is one that
                      matches the rest of the window — and clearing puts the caret
                      back where the typing was. Pulled toward the edge so the gap
                      round it is the same on all four sides. */}
                  {query !== '' && !searching && (
                    <IconButton
                      icon={X}
                      size="xs"
                      label={t('action.clearSearch')}
                      onClick={() => {
                        setQuery('')
                        setPage(0)
                        field.current?.focus()
                      }}
                      className="-mr-2"
                    />
                  )}
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <SelectControl
                  value={category ?? ''}
                  onValueChange={(value) => {
                    setCategory(value || null)
                    setPage(0)
                  }}
                  aria-label={t('plugins.category.all')}
                  size="sm"
                  containerClassName="w-36"
                >
                  <option value="">{t('plugins.category.all')}</option>
                  {categories.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </SelectControl>
                <SelectControl
                  value={sort}
                  aria-label={t('plugins.sort.label')}
                  onValueChange={(value) => {
                    setSort(value as PluginSort)
                    setPage(0)
                  }}
                  size="sm"
                  containerClassName="w-36"
                >
                  {(['relevance', 'updated', 'name', 'downloads'] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(`plugins.sort.${value}`)}
                    </option>
                  ))}
                </SelectControl>
                <IconButton
                  icon={RefreshCw}
                  size="sm"
                  label={t('plugins.index.refresh')}
                  onClick={() => {
                    setPage(0)
                    void search(query, category, sort, 0, true, tab === 'installable')
                  }}
                  disabled={searching}
                  className={searching ? '[&>svg]:animate-spin' : undefined}
                />
                <span className="min-w-0 flex-1 truncate text-ui-sm text-muted">
                  {t('plugins.index.summary', {
                    total,
                    page: landedPage + 1,
                    pages: Math.max(1, Math.ceil(total / pageSize)),
                  })}
                </span>
                <IconButton
                  icon={ChevronLeft}
                  size="sm"
                  label={t('plugins.page.previous')}
                  onClick={() => setPage(Math.max(0, landedPage - 1))}
                  disabled={searching || landedPage === 0}
                />
                <IconButton
                  icon={ChevronRight}
                  size="sm"
                  label={t('plugins.page.next')}
                  onClick={() => setPage(landedPage + 1)}
                  disabled={searching || !hasMore}
                />
              </div>
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

          {/* Grown by the reach of a focus ring on every side and padded back, so
              a card at the edge of the list keeps its ring instead of having it
              clipped by the scroller. On the right it is grown by the scrollbar
              too (11px, set in app.css), and the track is always reserved — the
              thumb is transparent until there is something to scroll — so the
              list is as wide as the toolbar above it whether or not it scrolls. */}
          <div
            ref={resultsViewport}
            className="-mt-1 -mr-[15px] -mb-1 -ml-1 min-h-0 flex-1 overflow-y-scroll overscroll-contain p-1"
          >
            {tab === 'discover' ? (
              <Discover
                results={results}
                searching={searching}
                selected={selected}
                working={working}
                onOpen={(listing) => void select(listing.name, listing.sourceId, listing.version)}
                isInstalled={(name) => isInstalled(profile, name)}
              />
            ) : tab === 'installable' ? (
              <Discover
                results={results}
                searching={searching}
                selected={selected}
                working={working}
                onOpen={(listing) => void select(listing.name, listing.sourceId, listing.version)}
                isInstalled={() => false}
              />
            ) : tab === 'installed' ? (
              <Installed
                plugins={installed}
                initialized={profile?.initialized ?? false}
                working={working}
                onOpen={selectInstalled}
                onCheckVersion={async (name) => {
                  if (activeSource?.id !== 'npm') await selectSource('npm')
                  if (
                    usePlugins
                      .getState()
                      .sources.some((source) => source.id === 'npm' && source.active)
                  ) {
                    await select(name, 'npm', 'latest')
                  }
                }}
                onToggle={(name, on) => void toggle(name, on)}
                onRemove={(name) => void confirmRemove(name)}
              />
            ) : (
              <Sources
                sources={sources}
                working={working !== null || sourceWorking}
                onSelect={(id) => void selectSource(id)}
                onManage={() => setManagingSources(true)}
              />
            )}
          </div>

          {working !== null && (
            <div className="card mt-3 flex shrink-0 items-center gap-2 px-4 py-2">
              <Loader2 size={16} className="shrink-0 animate-spin text-brand" aria-hidden="true" />
              <span className="truncate font-mono text-ui-sm text-muted">{latest || working}</span>
            </div>
          )}

          <footer className="mt-3 flex shrink-0 items-start gap-2 px-1">
            <Info
              size={14}
              strokeWidth={1.9}
              className="mt-0.5 shrink-0 text-faint"
              aria-hidden="true"
            />
            <p className="text-ui-sm text-muted">{t('plugins.restart')}</p>
          </footer>
        </div>
      </section>

      {/* Outside the pane rather than inside it: the pane plays a transform on
          arrival, and a transform is a containing block for anything fixed
          within it. */}
      {selected !== null && <PluginDialog onRemove={confirmRemove} />}
      {managingSources && <CatalogSourcesDialog onClose={() => setManagingSources(false)} />}
    </>
  )
}

/* -------------------------------------------------------------------------- */

interface SourcesProps {
  sources: CatalogSource[]
  working: boolean
  onSelect: (id: string) => void
  onManage: () => void
}

function Sources({ sources, working, onSelect, onManage }: SourcesProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-ui-base font-semibold text-text">{t('plugins.sources.title')}</h3>
          <p className="mt-1 text-ui-sm text-muted">{t('plugins.sources.subtitle')}</p>
        </div>
        <Button variant="secondary" onClick={onManage} disabled={working}>
          <Settings2 aria-hidden="true" />
          {t('plugins.sources.manage')}
        </Button>
      </div>

      <ul className="list-card">
        {sources.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              disabled={working || source.active}
              onClick={() => onSelect(source.id)}
              className="list-row list-row--roomy w-full text-left transition-colors enabled:hover:bg-surface-2/70 disabled:cursor-default"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-muted">
                <Database size={16} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-ui-base font-medium text-text">
                  <span className="truncate">{source.label}</span>
                  {source.builtIn && <Badge>{t('plugins.builtin')}</Badge>}
                </span>
                <span className="mt-0.5 block truncate font-mono text-ui-sm text-faint">
                  {source.endpoint ?? source.kind}
                </span>
              </span>
              {source.active ? (
                <Badge tone="ok">{t('plugins.sources.active')}</Badge>
              ) : (
                <span className="shrink-0 text-ui-sm text-muted">{t('plugins.sources.use')}</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <div className="card flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-ui-base font-medium text-text">{t('plugins.hub.title')}</p>
          <p className="mt-1 text-ui-sm text-muted">{t('plugins.hub.detail')}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void reportAction(() => openExternalUrl(DSH_HUB))}
        >
          <ExternalLink aria-hidden="true" />
          {t('plugins.hub.open')}
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface DiscoverProps {
  results: PluginListing[]
  searching: boolean
  selected: string | null
  working: string | null
  onOpen: (listing: PluginListing) => void
  isInstalled: (name: string) => boolean
}

export function Discover({
  results,
  searching,
  selected,
  working,
  onOpen,
  isInstalled,
}: DiscoverProps) {
  if (results.length === 0) {
    return (
      <Empty icon={Package} message={searching ? t('plugins.searching') : t('plugins.noResults')} />
    )
  }

  return (
    <ul
      className="grid grid-cols-1 gap-3 @min-[680px]:grid-cols-2"
      aria-label={t('plugins.tab.discover')}
      aria-busy={searching}
    >
      {results.map((listing) => {
        const here = isInstalled(listing.name)
        const busy = working === listing.name

        return (
          <li key={`${listing.sourceId}:${listing.name}`} className="min-w-0">
            {/* The whole card is the one button, so a second real button cannot
                live on it. The action drawn at the foot is that button's own
                label, dressed as the button it stands for. */}
            <button
              type="button"
              onClick={() => onOpen(listing)}
              disabled={working !== null}
              aria-label={`${pluginDisplayName(listing.name)} · ${listing.name} · ${t('plugins.details')}`}
              className={[
                'card card--interactive flex h-full w-full flex-col p-4 text-left disabled:cursor-wait',
                // Whatever is installing stays legible; only the rest step back.
                busy ? '' : 'disabled:opacity-60',
                selected === listing.name ? 'border-line-strong' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span className="flex w-full items-center gap-3">
                <Tile
                  key={`${listing.sourceId}\0${listing.name}\0${listing.version}`}
                  listing={listing}
                />

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui-base font-semibold text-text">
                    {pluginDisplayName(listing.name)}
                  </span>
                  <span className="block truncate text-ui-sm text-muted">
                    {listing.publisher || listing.sourceLabel}
                  </span>
                </span>
              </span>

              {/* Three lines are always reserved, so a row of cards is one height
                  whether or not each description fills them. */}
              <span className="mt-3 line-clamp-3 min-h-[3lh] text-ui-sm text-muted [overflow-wrap:anywhere]">
                {listing.description || t('plugins.noDescription')}
              </span>

              <span className="mt-auto flex w-full items-center gap-2 pt-4">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-ui-sm text-faint"
                  title={listing.name}
                >
                  {listing.name}
                </span>
                <Badge>
                  {listing.name.startsWith('@deepseek-ai/')
                    ? t('plugins.officialComponent')
                    : t('plugins.community')}
                </Badge>
              </span>

              <span className="mt-3 flex w-full items-center gap-3 border-t border-line pt-3 text-ui-sm text-faint">
                <span className="truncate tabular-nums">v{listing.version}</span>
                {listing.weeklyDownloads > 0 && (
                  <span className="truncate tabular-nums">
                    {t('plugins.downloads', { count: count(listing.weeklyDownloads) })}
                  </span>
                )}
                {/* Fixed at the button's height, so an installed card and one that
                    is not keep their rules and rows on the same lines. */}
                <span className="ml-auto flex h-7 shrink-0 items-center">
                  {busy ? (
                    <Badge>
                      <Loader2 className="animate-spin" aria-hidden="true" />
                      {t('plugins.installing')}
                    </Badge>
                  ) : here ? (
                    <Badge tone="ok">
                      <Check aria-hidden="true" />
                      {t('plugins.installed')}
                    </Badge>
                  ) : (
                    <span
                      className={buttonClass({
                        variant: 'secondary',
                        size: 'sm',
                        // While another install runs the card is inert, and its
                        // label should not answer the pointer as if it were not.
                        className: working !== null ? 'pointer-events-none' : undefined,
                      })}
                    >
                      {t('plugins.details')}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/* -------------------------------------------------------------------------- */

interface InstalledProps {
  plugins: InstalledPlugin[]
  initialized: boolean
  working: string | null
  onOpen: (plugin: InstalledPlugin) => void
  onCheckVersion: (name: string) => Promise<void>
  onToggle: (name: string, on: boolean) => void
  onRemove: (name: string) => void
}

function Installed({
  plugins,
  initialized,
  working,
  onOpen,
  onCheckVersion,
  onToggle,
  onRemove,
}: InstalledProps) {
  if (plugins.length === 0) {
    return (
      <Empty
        icon={Layers}
        message={initialized ? t('plugins.noneInstalled') : t('plugins.uninitialized')}
      />
    )
  }

  return (
    <ul className="list-card" aria-label={t('plugins.tab.installed')}>
      {plugins.map((plugin) => {
        // In the stack or taken out of it — either way there is a layer here to
        // switch. A package that declares no patch has none, and offering a
        // switch for it would promise something the harness would undo.
        const layered = plugin.active || plugin.disabled
        const busy = working === plugin.name
        const incompatible = plugin.compatibility?.state === 'incompatible'

        return (
          <li key={plugin.name} className="list-row list-row--roomy">
            <Tile muted={plugin.builtin || plugin.disabled} />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <button
                  type="button"
                  onClick={() => onOpen(plugin)}
                  data-hint={plugin.name}
                  className="group flex max-w-full min-w-0 items-baseline gap-2 text-left"
                >
                  <span
                    className={[
                      'truncate text-ui-base font-semibold group-hover:underline',
                      plugin.disabled ? 'text-muted' : 'text-text',
                    ].join(' ')}
                  >
                    {pluginDisplayName(plugin.name)}
                  </span>
                  {(plugin.installedVersion || plugin.spec) && (
                    <span className="max-w-full truncate font-mono text-ui-sm text-faint tabular-nums">
                      {plugin.installedVersion || plugin.spec}
                    </span>
                  )}
                </button>

                {plugin.disabled ? (
                  <Badge>{t('plugins.off')}</Badge>
                ) : incompatible ? (
                  <Badge tone="warn">{t('plugins.runtimeBlocked')}</Badge>
                ) : (
                  <Badge tone={plugin.active ? 'ok' : 'neutral'}>
                    {plugin.active ? t('plugins.layer') : t('plugins.library')}
                  </Badge>
                )}
                {plugin.builtin && <Badge>{t('plugins.builtin')}</Badge>}
                {plugin.marketReceipt && <Badge tone="ok">{t('plugins.marketManaged')}</Badge>}
              </div>

              <p className="mt-0.5 truncate text-ui-sm text-muted">{plugin.name}</p>
              {incompatible && !plugin.disabled && (
                <p className="mt-1 text-ui-sm text-warn [overflow-wrap:anywhere]">
                  {t('plugins.runtimeBlockedHint')}
                </p>
              )}
            </div>

            {!plugin.builtin && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onCheckVersion(plugin.name)}
                disabled={working !== null}
              >
                {t('plugins.checkVersion')}
              </Button>
            )}

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
              <IconButton
                icon={Trash2}
                variant="danger-ghost"
                size="sm"
                label={t('plugins.remove')}
                onClick={() => onRemove(plugin.name)}
                disabled={working !== null}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

/* -------------------------------------------------------------------------- */

function Tile({ listing, muted = false }: { listing?: PluginListing; muted?: boolean }) {
  const sourceId = listing?.sourceId ?? ''
  const name = listing?.name ?? ''
  const version = listing?.version ?? ''
  const hasIcon = listing?.hasIcon ?? false
  const key = listing ? `${sourceId}\0${name}\0${version}` : ''
  const [icon, setIcon] = useState<string | null | undefined>(() => ICONS.get(key))

  useEffect(() => {
    if (!hasIcon || icon !== undefined) return
    let active = true
    void ipc
      .pluginMedia(sourceId, name, version)
      .then((asset) => {
        const dataUrl = asset?.dataUrl ?? null
        ICONS.set(key, dataUrl)
        if (active) setIcon(dataUrl)
      })
      .catch(() => {
        ICONS.set(key, null)
        if (active) setIcon(null)
      })
    return () => {
      active = false
    }
  }, [hasIcon, icon, key, name, sourceId, version])

  return (
    <span
      aria-hidden="true"
      className={[
        'grid size-10 shrink-0 place-items-center rounded-lg border border-line',
        muted ? 'bg-surface-2/50 text-faint' : 'bg-surface-2 text-brand',
      ].join(' ')}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full rounded-lg object-cover"
        />
      ) : (
        <Package size={20} strokeWidth={1.8} />
      )}
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
        'mb-3 flex shrink-0 items-start gap-2 rounded-lg border px-3 py-2 text-ui-sm',
        tone === 'warn'
          ? 'border-warn/30 bg-warn/10 text-warn'
          : 'border-danger/30 bg-danger/10 text-danger',
      ].join(' ')}
    >
      <Icon size={14} strokeWidth={1.9} className="mt-0.5 shrink-0" aria-hidden="true" />
      <p className="selectable">{children}</p>
    </div>
  )
}

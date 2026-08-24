import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { open as pickFile } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
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

import { Button } from '@/components/Button'
import { PaneHeader } from '@/components/PaneHeader'
import { PluginDialog } from '@/components/PluginDialog'
import { CatalogSourcesDialog } from '@/components/CatalogSourcesDialog'
import { Switch } from '@/components/Switch'
import { TabButton } from '@/components/TabButton'
import { count, day, filesize } from '@/lib/format'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import type { CatalogSource, InstalledPlugin, PluginListing, PluginSort } from '@/lib/ipc'
import { ask } from '@/state/dialog'
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
    const path = await pickFile({
      title: t('plugins.importTitle'),
      filters: [{ name: t('plugins.importKind'), extensions: ['tgz', 'gz'] }],
    })
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
      () => void search(query, category, sort, page),
      query === '' ? 0 : DEBOUNCE,
    )
    return () => window.clearTimeout(timer)
  }, [query, category, sort, page, search, activeSource?.id, tab])

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
              label={t('plugins.tab.installable')}
              active={tab === 'installable'}
              onClick={() => setTab('installable')}
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
            <TabButton
              label={t('plugins.tab.sources')}
              active={tab === 'sources'}
              onClick={() => setTab('sources')}
            />
          </div>

          {/* Beside the tabs rather than inside either one: this installs, so it
              belongs with discovery, but it is the only way in on a machine
              where discovery finds nothing at all. */}
          <Button
            variant="secondary"
            onClick={() => void importArchive()}
            disabled={working !== null}
            data-hint={t('plugins.importHint')}
          >
            <PackagePlus size={13} strokeWidth={2.2} aria-hidden="true" />
            {t('plugins.import')}
          </Button>
        </PaneHeader>

        {(tab === 'discover' || tab === 'installable') && (
          <div className="shrink-0 border-b border-line">
            <div className="flex h-11 items-center gap-2 px-4">
              <select
                value={activeSource?.id ?? 'npm'}
                disabled={working !== null || sourceWorking}
                onChange={(event) => {
                  setCategory(null)
                  setPage(0)
                  void selectSource(event.target.value)
                }}
                aria-label={t('plugins.source')}
                className="h-7 max-w-[150px] rounded-control border border-line bg-surface-2 px-2 text-[11px] text-muted outline-none focus:border-brand"
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setManagingSources(true)}
                disabled={working !== null || sourceWorking}
                data-hint={t('plugins.sources.manage')}
                aria-label={t('plugins.sources.manage')}
                className="grid size-7 shrink-0 place-items-center rounded-control text-faint transition-colors hover:bg-surface-2 hover:text-text"
              >
                <Settings2 size={13} aria-hidden="true" />
              </button>
              <Search
                size={14}
                strokeWidth={2.1}
                className="shrink-0 text-faint"
                aria-hidden="true"
              />
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
                  data-hint={t('action.clearSearch')}
                  aria-label={t('action.clearSearch')}
                  onClick={() => {
                    setQuery('')
                    setPage(0)
                    field.current?.focus()
                  }}
                  className="grid size-[17px] shrink-0 place-items-center rounded-full text-faint transition-colors duration-100 hover:bg-surface-2 hover:text-text"
                >
                  <X size={11} strokeWidth={2.4} aria-hidden="true" />
                </button>
              )}
            </div>

            <div className="flex h-9 items-center gap-2 border-t border-line/70 px-4">
              <select
                value={category ?? ''}
                onChange={(event) => {
                  setCategory(event.target.value || null)
                  setPage(0)
                }}
                aria-label={t('plugins.category.all')}
                className="h-7 max-w-[170px] rounded-control border border-line bg-surface-2 px-2 text-[11px] text-muted outline-none focus:border-brand"
              >
                <option value="">{t('plugins.category.all')}</option>
                {categories.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                value={sort}
                aria-label={t('plugins.sort.label')}
                onChange={(event) => {
                  setSort(event.target.value as PluginSort)
                  setPage(0)
                }}
                className="h-7 rounded-control border border-line bg-surface-2 px-2 text-[11px] text-muted outline-none focus:border-brand"
              >
                {(['relevance', 'updated', 'name', 'downloads'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`plugins.sort.${value}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setPage(0)
                  void search(query, category, sort, 0, true)
                }}
                disabled={searching}
                data-hint={t('plugins.index.refresh')}
                aria-label={t('plugins.index.refresh')}
                className="grid size-7 shrink-0 place-items-center rounded-control text-faint transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40"
              >
                <RefreshCw
                  size={12}
                  className={searching ? 'animate-spin' : ''}
                  aria-hidden="true"
                />
              </button>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-faint">
                {t('plugins.index.summary', {
                  total,
                  page: landedPage + 1,
                  pages: Math.max(1, Math.ceil(total / pageSize)),
                })}
              </span>
              <button
                type="button"
                onClick={() => setPage(Math.max(0, landedPage - 1))}
                disabled={searching || landedPage === 0}
                aria-label={t('plugins.page.previous')}
                className="grid size-7 place-items-center rounded-control text-faint hover:bg-surface-2 hover:text-text disabled:opacity-30"
              >
                <ChevronLeft size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setPage(landedPage + 1)}
                disabled={searching || !hasMore}
                aria-label={t('plugins.page.next')}
                className="grid size-7 place-items-center rounded-control text-faint hover:bg-surface-2 hover:text-text disabled:opacity-30"
              >
                <ChevronRight size={13} aria-hidden="true" />
              </button>
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

        <div className="min-h-0 flex-1 overflow-y-auto">
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
              results={results.filter(
                (listing) => listing.installable && !isInstalled(profile, listing.name),
              )}
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
    <div className="p-4">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[12.5px] font-medium text-text">{t('plugins.sources.title')}</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-faint">
            {t('plugins.sources.subtitle')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" onClick={() => void openUrl(DSH_HUB)}>
            <ExternalLink size={13} aria-hidden="true" />
            {t('plugins.hub.open')}
          </Button>
          <Button variant="secondary" onClick={onManage} disabled={working}>
            <Settings2 size={13} aria-hidden="true" />
            {t('plugins.sources.manage')}
          </Button>
        </div>
      </div>
      <div className="mb-3 rounded-control border border-line bg-canvas-deep/50 px-3 py-2.5">
        <p className="text-[11.5px] font-medium text-text">{t('plugins.hub.title')}</p>
        <p className="mt-1 text-[10.5px] leading-relaxed text-faint">{t('plugins.hub.detail')}</p>
      </div>
      <ul className="overflow-hidden rounded-control border border-line">
        {sources.map((source) => (
          <li key={source.id} className="border-b border-line last:border-b-0">
            <button
              type="button"
              disabled={working || source.active}
              onClick={() => onSelect(source.id)}
              className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors enabled:hover:bg-surface-2/60 disabled:cursor-default"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-control border border-line bg-surface-2 text-brand">
                <Database size={14} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[12px] font-medium text-text">
                  <span className="truncate">{source.label}</span>
                  {source.builtIn && (
                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[9.5px] text-faint">
                      {t('plugins.builtin')}
                    </span>
                  )}
                </span>
                <span className="mt-1 block truncate font-mono text-[10px] text-faint">
                  {source.endpoint ?? source.kind}
                </span>
              </span>
              <span className={source.active ? 'text-[11px] text-ok' : 'text-[11px] text-faint'}>
                {source.active ? t('plugins.sources.active') : t('plugins.sources.use')}
              </span>
            </button>
          </li>
        ))}
      </ul>
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
              onClick={() => onOpen(listing)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen(listing)
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

              <Tile
                key={`${listing.sourceId}\0${listing.name}\0${listing.version}`}
                listing={listing}
              />

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
                  <span className="truncate text-brand/80">{listing.sourceLabel}</span>
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
                  onOpen(listing)
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
  onOpen: (plugin: InstalledPlugin) => void
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
                onClick={() => onOpen(plugin)}
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
                {plugin.marketReceipt && <Badge tone="ok">{t('plugins.marketManaged')}</Badge>}
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
        'mt-0.5 grid size-8 shrink-0 place-items-center rounded-[7px] border border-line',
        muted ? 'bg-surface-2/50 text-faint' : 'bg-surface-2 text-brand',
      ].join(' ')}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full rounded-[6px] object-cover"
        />
      ) : (
        <Package size={15} strokeWidth={1.9} />
      )}
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

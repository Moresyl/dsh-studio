import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Bot,
  Bookmark,
  Pin,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCopy,
  FileCode2,
  FileOutput,
  FileText,
  Image,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Search,
  TriangleAlert,
  User,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'

import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { AttachmentPreview } from '@/components/AttachmentPreview'
import { Empty } from '@/components/Empty'
import { IconButton } from '@/components/IconButton'
import { PaneHeader } from '@/components/PaneHeader'
import { Segmented } from '@/components/Segmented'
import { UsageReport } from '@/components/UsageReport'
import { SessionActions } from '@/components/SessionOrganizer'
import { SessionBatch } from '@/components/SessionBatch'
import { toggleSelection, visibleSelection, type SessionSelection } from '@/lib/batch-selection'
import {
  annotationFor,
  annotationMatches,
  emptyAnnotation,
  organizeSessions,
  sessionTitle,
  useLibrary,
} from '@/state/library'
import { count, day, filesize, leaf, when } from '@/lib/format'
import { t } from '@/lib/i18n'
import { attachmentPreviewKind } from '@/lib/attachment-kind'
import { sessionPage } from '@/lib/session-page'
import type { MessageKey } from '@/lib/i18n'
import type {
  Role,
  SessionCard,
  SessionFormat,
  SessionHit,
  SessionLine,
  SessionAttachment,
  SessionMark,
  Tokens,
} from '@/lib/ipc'
import { SEPARATOR, useMenu, type MenuEntry } from '@/state/menu'
import { projects, spent, useSessions } from '@/state/sessions'

/** Long enough that a search runs on words rather than on keystrokes. */
const DEBOUNCE = 320

/** How much of a long line is shown before the rest has to be asked for. */
const PEEK_LINES = 8
const PEEK_CHARS = 640

/** How long an export leaves its tick behind, before the button is itself again. */
const CONFIRM = 1600

/**
 * The column everything in this pane sits in.
 *
 * The header centres its content in 1040px, so the strips, rows and transcript
 * lines do too. Their fills and hairlines still run edge to edge, but their text
 * stays on the header's left edge at every window width — not only while the
 * window is narrower than the column.
 */
const COLUMN = 'mx-auto w-full max-w-[1040px]'

/**
 * The formats a session can leave in, and what a save dialog calls each one.
 *
 * Ordered by how likely somebody is to want it. Markdown is what an issue or a
 * weekly note takes; HTML is the one that opens on any machine with no tooling
 * at all, which is what to send someone who does not have this app; JSON is for
 * whatever reads it after that.
 */
const FORMATS: {
  format: SessionFormat
  icon: LucideIcon
  save: MessageKey
  /** What the save dialog's filter should call this sort of file. */
  kind: MessageKey
}[] = [
  {
    format: 'markdown',
    icon: FileText,
    save: 'sessions.saveMarkdown',
    kind: 'sessions.kindMarkdown',
  },
  { format: 'html', icon: FileCode2, save: 'sessions.saveHtml', kind: 'sessions.kindHtml' },
  { format: 'json', icon: Braces, save: 'sessions.saveJson', kind: 'sessions.kindJson' },
]

const ROLE: Record<Role, MessageKey> = {
  user: 'sessions.role.user',
  assistant: 'sessions.role.assistant',
  tool: 'sessions.role.tool',
  context: 'sessions.role.context',
}

const MARKER: Record<Role, LucideIcon> = {
  user: User,
  assistant: Bot,
  tool: Wrench,
  context: FileText,
}

/**
 * The left edge each kind of line wears.
 *
 * A transcript is read by skimming for one's own words and then reading down
 * from there, so what the eye needs is a rail it can run along — not a chat
 * bubble per line, which at the length these lines reach would leave a pane of
 * ragged boxes and no column to follow.
 */
const RAIL: Record<Role, string> = {
  user: 'border-brand/70 bg-brand/[0.05]',
  assistant: 'border-line',
  tool: 'border-line-strong bg-canvas-deep/35',
  context: 'border-transparent',
}

/**
 * Every conversation the harness has had on this machine.
 *
 * The harness keeps its logs and does not read them back: there is no list, no
 * search, and no way to reach a session again once it has scrolled off. So this
 * pane is not a view onto a feature — it is the feature, and the whole of it
 * lives on the native side, where a few hundred megabytes of compressed JSONL
 * can be scanned without a runtime holding it all at once.
 *
 * Two things share the pane rather than sitting in a split, and it is the same
 * reason both times: what is being read here is wide. A transcript carries tool
 * output — diffs, file dumps, stack traces — and a rail down one side would
 * halve the only dimension that matters to it. So the list is the pane, and
 * opening a session replaces it.
 *
 * Search results quote the line that matched and every quote is a way in: the
 * point of finding a session is not the session, it is the moment inside it.
 */
export function SessionsPane() {
  const cards = useSessions((state) => state.cards)
  const archived = useSessions((state) => state.archived)
  const hits = useSessions((state) => state.hits)
  const asked = useSessions((state) => state.query)
  const project = useSessions((state) => state.project)
  const opened = useSessions((state) => state.opened)
  const opening = useSessions((state) => state.opening)
  const scanning = useSessions((state) => state.scanning)
  const searching = useSessions((state) => state.searching)
  const error = useSessions((state) => state.error)
  const refresh = useSessions((state) => state.refresh)
  const search = useSessions((state) => state.search)
  const narrow = useSessions((state) => state.narrow)
  const open = useSessions((state) => state.open)
  const close = useSessions((state) => state.close)
  const searchRequest = useSessions((state) => state.searchRequest)
  const tab = useSessions((state) => state.tab)
  const setTab = useSessions((state) => state.setTab)

  const field = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const annotations = useLibrary((state) => state.data.sessions)
  const loadLibrary = useLibrary((state) => state.load)
  const libraryError = useLibrary((state) => state.error)
  const [pinned, setPinned] = useState(false)
  const [tag, setTag] = useState('')
  const [order, setOrder] = useState<'recent' | 'oldest' | 'title'>('recent')
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<SessionSelection>({ scope: '', ids: [] })
  const [batch, setBatch] = useState<string[] | null>(null)
  const libraryReady = useLibrary((state) => state.loaded && !state.busy)
  /** The line an opened session should land on, when a quote is what opened it. */
  const [anchor, setAnchor] = useState<number | null>(null)
  // The statement is a second reading of the same shelf, not a seventh pane in
  // the rail: nobody goes looking for "usage" without a session in mind, and a
  // rail that grows an entry per question stops being a rail.

  useEffect(() => {
    void refresh()
    void loadLibrary()
  }, [refresh, loadLibrary])

  useEffect(() => {
    if (searchRequest === 0) return
    field.current?.focus()
  }, [searchRequest])

  // Emptying the box is not a keystroke to wait out — it is the moment the list
  // underneath becomes the answer again.
  useEffect(() => {
    const timer = window.setTimeout(() => void search(query), query === '' ? 0 : DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [query, search])

  const listed = useMemo(
    () =>
      organizeSessions(
        (cards ?? []).filter(
          (card) =>
            (project === null || card.project === project) &&
            (tab === 'archived' ? archived.includes(card.id) : !archived.includes(card.id)),
        ),
        annotations,
        tab === 'usage' ? {} : { pinned, tag, order },
      ),
    [archived, cards, project, tab, annotations, pinned, tag, order],
  )

  const visibleHits = useMemo(() => {
    if (!hits) return hits
    const visible = hits.filter((hit) => listed.some((card) => card.id === hit.card.id))
    const matched = new Set(visible.map((hit) => hit.card.id))
    return [
      ...visible,
      ...listed
        .filter((card) => !matched.has(card.id) && annotationMatches(card, annotations, asked))
        .map((card) => ({ card, matches: 0, marks: [] })),
    ]
  }, [hits, listed, annotations, asked])

  const reach = useMemo(() => projects(cards ?? []), [cards])
  const scope = JSON.stringify([query, asked, project, tab, pinned, tag, order])
  const visibleIds = visibleHits
    ? visibleHits.map((hit) => hit.card.id)
    : listed.map((card) => card.id)
  const selectedIds = visibleSelection(selection, scope, visibleIds)
  const selectionReady = libraryReady && !searching && query === asked
  const choose = (id: string) => setSelection({ scope, ids: toggleSelection(selectedIds, id) })

  const show = (id: string, seq: number | null) => {
    setAnchor(seq)
    void open(id)
  }

  const back = () => {
    setAnchor(null)
    close()
  }

  if (opened || opening) {
    return (
      <Reader
        key={opened?.card.id ?? opening}
        card={opened?.card ?? null}
        lines={opened?.lines ?? null}
        anchor={anchor}
        onBack={back}
      />
    )
  }

  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col bg-canvas">
      <PaneHeader
        title={t('sessions.title')}
        subtitle={
          tab === 'usage'
            ? t('usage.subtitle')
            : tab === 'archived'
              ? t('sessions.archiveSubtitle')
              : t('sessions.subtitle')
        }
      >
        <Segmented
          label={t('sessions.title')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'list', label: t('sessions.tab.list') },
            { value: 'archived', label: t('sessions.tab.archived') },
            { value: 'usage', label: t('sessions.tab.usage') },
          ]}
        />

        {/* The icon spins through the button's own `svg` rather than through a
            prop of its own: a refresh that only disables itself gives no sign
            that anything is being read. */}
        <IconButton
          variant="secondary"
          size="md"
          icon={RefreshCw}
          label={t('sessions.refresh')}
          onClick={() => void refresh()}
          disabled={scanning}
          className={scanning ? '[&>svg]:animate-spin' : undefined}
        />
      </PaneHeader>

      {listed.some((card) => card.limited) && <Warning message={t('sessions.limitedShelf')} />}
      {libraryError && <Warning message={libraryError} />}

      {tab === 'usage' ? (
        <UsageReport cards={listed} onOpen={(id) => show(id, null)} />
      ) : (
        <>
          <div className="shrink-0 px-6">
            <div className={`${COLUMN} flex items-center gap-2 pb-3`}>
              <label className="field-shell min-w-0 flex-1">
                <Search size={16} strokeWidth={1.8} aria-hidden="true" />
                <input
                  ref={field}
                  aria-label={t('sessions.search')}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && query !== '') {
                      event.stopPropagation()
                      setQuery('')
                    }
                  }}
                  placeholder={t('sessions.search')}
                  spellCheck={false}
                  autoComplete="off"
                  className="selectable"
                />
                {searching && (
                  <Loader2
                    size={16}
                    strokeWidth={1.8}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                )}
                {query !== '' && !searching && (
                  <IconButton
                    size="xs"
                    icon={X}
                    label={t('action.clearSearch')}
                    onClick={() => {
                      setQuery('')
                      field.current?.focus()
                    }}
                    className="-mr-2"
                  />
                )}
              </label>

              <Filter project={project} reach={reach} onPick={(picked) => void narrow(picked)} />
            </div>
          </div>

          <div className="shrink-0 px-6 pb-3">
            <div className={`${COLUMN} flex flex-wrap items-center gap-2`}>
              <Button
                variant={pinned ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={pinned}
                onClick={() => setPinned(!pinned)}
              >
                <Pin />
                {t('organize.pinned')}
              </Button>
              <FilterTags
                value={tag}
                values={[
                  ...new Set(
                    (cards ?? []).flatMap(
                      (card) => annotationFor(annotations, card.id)?.tags ?? [],
                    ),
                  ),
                ].sort()}
                onChange={setTag}
              />
              <button
                type="button"
                className="select-trigger select-trigger--sm"
                aria-haspopup="menu"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  useMenu.getState().show(
                    box.left,
                    box.bottom + 4,
                    (['recent', 'oldest', 'title'] as const).map((value) => ({
                      label: t(`organize.order.${value}`),
                      selected: value === order,
                      run: () => setOrder(value),
                    })),
                  )
                }}
              >
                {t(`organize.order.${order}`)}
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              <Button
                variant={selecting ? 'secondary' : 'ghost'}
                size="sm"
                disabled={!selectionReady}
                aria-pressed={selecting}
                onClick={() => {
                  setSelecting(!selecting)
                  setSelection({ scope, ids: [] })
                }}
              >
                {t('batch.open')}
              </Button>
              {selecting && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!selectionReady || !visibleIds.length}
                    onClick={() =>
                      setSelection({ scope, ids: [...new Set(visibleIds)].slice(0, 500) })
                    }
                  >
                    {t('batch.all')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!selectionReady || !selectedIds.length}
                    onClick={() => setBatch([...selectedIds])}
                  >
                    {t('batch.count', { count: selectedIds.length })}
                  </Button>
                </>
              )}
            </div>
          </div>

          {listed.length > 0 && <Totals cards={listed} hits={visibleHits} />}

          {error && <Warning message={error} />}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {visibleHits ? (
              visibleHits.length === 0 ? (
                <Empty
                  icon={Search}
                  message={
                    searching ? t('sessions.scanning') : t('sessions.noResults', { query: asked })
                  }
                  hint={searching ? undefined : t('sessions.noResultsHint')}
                />
              ) : (
                <ul>
                  {visibleHits.map((hit) => (
                    <Entry
                      key={hit.card.id}
                      card={hit.card}
                      matches={hit.matches}
                      marks={hit.marks}
                      selection={
                        selecting
                          ? {
                              selected: selectedIds.includes(hit.card.id),
                              toggle: () => choose(hit.card.id),
                              disabled:
                                !selectionReady ||
                                (!selectedIds.includes(hit.card.id) && selectedIds.length >= 500),
                            }
                          : undefined
                      }
                      onOpen={(seq) => show(hit.card.id, seq)}
                    />
                  ))}
                </ul>
              )
            ) : listed.length === 0 ? (
              <Empty
                icon={scanning ? Loader2 : tab === 'archived' ? Archive : MessagesSquare}
                spin={scanning}
                message={
                  scanning
                    ? t('sessions.scanning')
                    : tab === 'archived'
                      ? t('sessions.archiveEmpty')
                      : t('sessions.empty')
                }
                hint={
                  scanning
                    ? undefined
                    : tab === 'archived'
                      ? t('sessions.archiveEmptyHint')
                      : t('sessions.emptyHint')
                }
              />
            ) : (
              <ul>
                {listed.map((card) => (
                  <Entry
                    key={card.id}
                    card={card}
                    onOpen={() => show(card.id, null)}
                    selection={
                      selecting
                        ? {
                            selected: selectedIds.includes(card.id),
                            toggle: () => choose(card.id),
                            disabled:
                              !selectionReady ||
                              (!selectedIds.includes(card.id) && selectedIds.length >= 500),
                          }
                        : undefined
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      {batch && (
        <SessionBatch
          ids={batch}
          onClose={() => setBatch(null)}
          onSaved={() => {
            setBatch(null)
            setSelection({ scope, ids: [] })
          }}
        />
      )}
    </section>
  )
}

/** Something that went wrong, said in place rather than over the top of anything. */
function Warning({ message }: { message: string }) {
  return (
    <div className="shrink-0 px-6 pb-3">
      <div
        className={`${COLUMN} flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger`}
      >
        <TriangleAlert size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p className="selectable min-w-0 break-words">{message}</p>
      </div>
    </div>
  )
}

/**
 * The line of sums under a toolbar: what the shelf on screen adds up to, or what
 * the session being read does. Muted, because it is the answer to a question
 * nobody asked out loud, and a hairline under it because the rows start there.
 */
function Strip({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 border-b border-line px-6">
      <div
        className={`${COLUMN} flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-ui-sm text-muted tabular-nums`}
      >
        {children}
      </div>
    </div>
  )
}

/** What the shelf on screen adds up to — the answer to "where did it all go". */
function Totals({ cards, hits }: { cards: SessionCard[]; hits: SessionHit[] | null }) {
  const tokens = spent(cards)
  const turns = cards.reduce((sum, card) => sum + card.turns, 0)

  return (
    <Strip>
      <span>
        {hits
          ? t('sessions.found', { count: hits.length, total: cards.length })
          : t('sessions.count', { count: cards.length })}
      </span>
      <span>{t('sessions.turns', { count: turns })}</span>

      <Spend tokens={tokens} />
    </Strip>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <span className="text-faint">{label} </span>
      <span className="font-medium">{count(value)}</span>
    </span>
  )
}

interface EntryProps {
  card: SessionCard
  selection?: { selected: boolean; toggle: () => void; disabled: boolean }
  /** How many lines answered the search, on the rows a search produced. */
  matches?: number
  marks?: SessionMark[]
  onOpen: (seq: number | null) => void
}

/** One session in the list: what was asked, where, and what it cost. */
function Entry({ card, matches, marks, onOpen, selection }: EntryProps) {
  const annotations = useLibrary((state) => state.data.sessions)
  const item = annotationFor(annotations, card.id)
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            if (event.target !== event.currentTarget) return
            event.preventDefault()
            onOpen(null)
          }
        }}
        className="border-b border-line px-6 py-3 text-left transition-colors duration-100 hover:bg-surface-2/60 focus-visible:-outline-offset-2"
      >
        <div className={`${COLUMN} flex flex-col gap-1`}>
          <div className="flex items-center gap-2">
            {selection && (
              <input
                type="checkbox"
                className="selection-checkbox"
                checked={selection.selected}
                disabled={selection.disabled}
                aria-label={t('batch.select', {
                  title: sessionTitle(card, annotations) || t('sessions.untitled'),
                })}
                onClick={(event) => event.stopPropagation()}
                onChange={selection.toggle}
              />
            )}
            <span className="min-w-0 flex-1 truncate text-ui-base font-medium text-text">
              {sessionTitle(card, annotations) || t('sessions.untitled')}
            </span>
            {card.delegated && (
              <Badge data-hint={t('sessions.delegatedHint')}>{t('sessions.delegated')}</Badge>
            )}
            {card.limited && (
              <Badge tone="warn" data-hint={t('sessions.limited')}>
                {t('sessions.limitedBadge')}
              </Badge>
            )}
            <span className="shrink-0 text-ui-sm text-faint tabular-nums">
              {when(card.touched)}
            </span>
            <SessionActions card={card} />
          </div>

          {!!item?.tags.length && (
            <div className="flex flex-wrap gap-1">
              {item.tags.map((label) => (
                <Badge key={label}>{label}</Badge>
              ))}
            </div>
          )}
          {!!item?.note && (
            <p className="line-clamp-2 text-ui-sm leading-relaxed text-muted">{item.note}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-faint">
            <span className="truncate" data-hint={card.project || undefined}>
              {card.project ? leaf(card.project) : t('sessions.noProject')}
            </span>
            <span className="tabular-nums">{t('sessions.turns', { count: card.turns })}</span>
            <span className="tabular-nums">
              {count(card.tokens.input + card.tokens.output)} tokens
            </span>
            {matches !== undefined && (
              <Badge tone="info" className="tabular-nums">
                {t('sessions.matches', { count: matches })}
              </Badge>
            )}
          </div>

          {marks && marks.length > 0 && (
            <ul className="mt-1 flex flex-col gap-1">
              {marks.map((mark, index) => (
                <li key={`${mark.seq}-${index}`}>
                  <button
                    type="button"
                    data-hint={t('sessions.jump')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onOpen(mark.seq)
                    }}
                    className="flex h-7 w-full items-center gap-2 rounded-md border-l-2 border-line-strong bg-canvas-deep/60 px-2 text-left transition-colors duration-100 hover:border-brand hover:bg-canvas-deep"
                  >
                    <span className="shrink-0 text-ui-xs text-faint uppercase">
                      {mark.tool ?? t(ROLE[mark.role])}
                    </span>
                    {/* One line, cut at both ends by the native side, so a match
                        in the middle of a file dump still arrives as a sentence. */}
                    <span className="min-w-0 flex-1 truncate text-ui-sm text-muted">
                      {mark.before}
                      <mark>{mark.hit}</mark>
                      {mark.after}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  )
}

interface ReaderProps {
  card: SessionCard | null
  lines: SessionLine[] | null
  /** The line the quote that opened this pointed at, if a quote did. */
  anchor: number | null
  onBack: () => void
}

/** One session, read back in full. */
function Reader({ card, lines, anchor, onBack }: ReaderProps) {
  const annotations = useLibrary((state) => state.data.sessions)
  const [bookmarksOnly, setBookmarksOnly] = useState(false)
  const bookmarks = card ? (annotationFor(annotations, card.id)?.bookmarks ?? []) : []
  const shownLines = bookmarksOnly
    ? (lines ?? []).filter((line) => bookmarks.includes(line.seq))
    : (lines ?? [])
  const error = useSessions((state) => state.error)
  const archiving = useSessions((state) => state.archiving)
  const archived = useSessions((state) => state.archived)
  const archive = useSessions((state) => state.archive)
  const body = useRef<HTMLDivElement>(null)
  const [requestedPage, setRequestedPage] = useState<number | null>(null)
  const page = sessionPage(shownLines, requestedPage, anchor)

  // The point of a search result is the moment inside the session, so arriving
  // at the top of a thousand-line transcript would be arriving nowhere.
  useEffect(() => {
    if (!lines) return
    if (requestedPage === null && anchor !== null)
      body.current?.querySelector(`[data-seq="${anchor}"]`)?.scrollIntoView({ block: 'center' })
    else body.current?.scrollTo({ top: 0 })
  }, [lines, anchor, requestedPage])

  // Escape leaves a drilled-into view on every desktop platform. Skipped while
  // a modal is up, because then the key belongs to the thing in front.
  useEffect(() => {
    const leave = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[aria-modal="true"]')) return
      onBack()
    }

    window.addEventListener('keydown', leave)
    return () => window.removeEventListener('keydown', leave)
  }, [onBack])

  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col bg-canvas">
      <PaneHeader
        title={
          card ? sessionTitle(card, annotations) || t('sessions.untitled') : t('sessions.opening')
        }
        subtitle={card?.project ? leaf(card.project) : undefined}
        subtitleHint={card?.project}
      >
        {card && <Export id={card.id} />}
        {card && <SessionActions card={card} size="md" variant="secondary" />}
        <Button
          variant="secondary"
          aria-pressed={bookmarksOnly}
          onClick={() => {
            setBookmarksOnly(!bookmarksOnly)
            setRequestedPage(null)
          }}
        >
          <Bookmark />
          {t('organize.bookmarks', { count: bookmarks.length })}
        </Button>

        {card && (
          <Button
            variant="secondary"
            disabled={archiving !== null}
            onClick={() =>
              void archive(card.id, !archived.includes(card.id)).then((done) => done && onBack())
            }
          >
            {archiving === card.id ? (
              <Loader2 className="animate-spin" />
            ) : archived.includes(card.id) ? (
              <ArchiveRestore />
            ) : (
              <Archive />
            )}
            {archived.includes(card.id) ? t('sessions.restore') : t('sessions.archive')}
          </Button>
        )}

        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft />
          {t('sessions.back')}
        </Button>
      </PaneHeader>

      {error && <Warning message={error} />}
      {card?.limited && <Warning message={t('sessions.limited')} />}

      {card && (
        <Strip>
          {card.started > 0 && <span>{day(new Date(card.started).toISOString())}</span>}
          <span>{t('sessions.turns', { count: card.turns })}</span>
          {card.models.map((model) => (
            <span key={model} className="truncate font-mono">
              {model}
            </span>
          ))}
          <Spend tokens={card.tokens} />
        </Strip>
      )}

      <div ref={body} className="min-h-0 flex-1 overflow-y-auto">
        {lines && bookmarksOnly && shownLines.length === 0 ? (
          <Empty
            icon={Bookmark}
            message={t('organize.noBookmarks')}
            hint={t('organize.noBookmarksHint')}
          />
        ) : lines ? (
          shownLines
            .slice(page.start, page.end)
            .map((line, index) => (
              <Turn
                key={`${line.seq}-${index}`}
                line={line}
                lit={line.seq === anchor}
                sessionId={card?.id ?? ''}
              />
            ))
        ) : (
          <Empty icon={Loader2} spin message={t('sessions.opening')} />
        )}
      </div>
      {lines && page.pages > 1 && (
        <nav
          aria-label={t('sessions.page.navigation')}
          className="shrink-0 border-t border-line px-6 py-3"
        >
          <div className={`${COLUMN} flex flex-wrap items-center gap-2`}>
            <span role="status" className="min-w-0 flex-1 text-ui-sm text-muted tabular-nums">
              {t('sessions.page.range', {
                start: page.start + 1,
                end: page.end,
                total: shownLines.length,
              })}
            </span>
            {[
              {
                label: t('sessions.page.first'),
                icon: ChevronsLeft,
                target: 0,
                disabled: page.page === 0,
              },
              {
                label: t('sessions.page.previous'),
                icon: ChevronLeft,
                target: page.page - 1,
                disabled: page.page === 0,
              },
              {
                label: t('sessions.page.next'),
                icon: ChevronRight,
                target: page.page + 1,
                disabled: page.page === page.pages - 1,
              },
              {
                label: t('sessions.page.last'),
                icon: ChevronsRight,
                target: page.pages - 1,
                disabled: page.page === page.pages - 1,
              },
            ].map(({ label, icon, target, disabled }) => (
              <IconButton
                key={label}
                variant="secondary"
                size="sm"
                icon={icon}
                label={label}
                disabled={disabled}
                onClick={() => setRequestedPage(target)}
              />
            ))}
          </div>
        </nav>
      )}
    </section>
  )
}

/**
 * The session, on its way somewhere else.
 *
 * A conversation that only exists inside this window is one nobody else can
 * read. The two ways out are a clipboard and a file, and they share a menu
 * rather than taking a button each because it is the same document either way —
 * what changes is only who reads it next.
 */
function Export({ id }: { id: string }) {
  const exporting = useSessions((state) => state.exporting)
  const copyOut = useSessions((state) => state.copyOut)
  const saveOut = useSessions((state) => state.saveOut)

  /** True for a moment after something worked, which is the whole confirmation. */
  const [done, setDone] = useState(false)

  // On a timer rather than until the next press, so a tick is never left
  // sitting on a button whose last click is minutes behind it.
  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(() => setDone(false), CONFIRM)
    return () => window.clearTimeout(timer)
  }, [done])

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const entries: MenuEntry[] = [
      {
        // Markdown and only Markdown up here: the reason to copy a session
        // rather than save it is to paste it somewhere that renders Markdown,
        // and HTML source in an issue comment is worse than no session at all.
        label: t('sessions.copyMarkdown'),
        icon: ClipboardCopy,
        run: () => {
          void copyOut(id, 'markdown').then((written) => setDone(written))
        },
      },
      SEPARATOR,
      ...FORMATS.map(({ format, icon, save, kind }) => ({
        label: t(save),
        icon,
        run: () => {
          void saveOut(id, format, t(kind)).then((written) => setDone(written))
        },
      })),
    ]

    const box = event.currentTarget.getBoundingClientRect()
    useMenu.getState().show(box.left, box.bottom + 4, entries)
  }

  return (
    <Button
      variant="secondary"
      aria-haspopup="menu"
      disabled={exporting}
      data-hint={t('sessions.exportHint')}
      onClick={open}
    >
      {/* The label is fixed and only the mark on it changes. A button that
          renamed itself to "Copied" would move the one beside it, and a header
          that shifts under the pointer is how a click lands on the wrong thing. */}
      {exporting ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : done ? (
        <Check className="text-ok" aria-hidden="true" />
      ) : (
        <FileOutput aria-hidden="true" />
      )}
      {t('sessions.export')}
    </Button>
  )
}

function Spend({ tokens }: { tokens: Tokens }) {
  return (
    <span className="ml-auto flex items-center gap-3" data-hint={t('sessions.spentHint')}>
      <Figure label={t('sessions.input')} value={tokens.input} />
      <Figure label={t('sessions.output')} value={tokens.output} />
      <Figure label={t('sessions.cached')} value={tokens.cacheRead} />
    </span>
  )
}

/** One line of the transcript, long ones folded until asked for. */
function Turn({ line, lit, sessionId }: { line: SessionLine; lit: boolean; sessionId: string }) {
  const item =
    useLibrary((state) => annotationFor(state.data.sessions, sessionId)) ?? emptyAnnotation()
  const marked = item.bookmarks.includes(line.seq)
  const disabled = useLibrary((state) => state.busy || !state.loaded)
  const [shown, setShown] = useState(false)
  const [preview, setPreview] = useState<SessionAttachment | null>(null)
  const Icon = MARKER[line.role]
  const machine = line.role === 'tool'
  const { head, folded } = fold(line.text)

  return (
    <article
      data-seq={line.seq}
      data-search-hit={lit || undefined}
      className={[
        'border-b border-l-2 border-b-line/60 px-6 py-3',
        RAIL[line.role],
        lit ? 'bg-brand/[0.11]' : '',
      ].join(' ')}
    >
      <div className={COLUMN}>
        <div className="mb-1 flex items-center gap-2">
          <Icon
            size={14}
            strokeWidth={1.8}
            className={line.role === 'user' ? 'text-brand' : 'text-faint'}
            aria-hidden="true"
          />
          <span
            className={[
              'text-ui-sm font-semibold',
              line.role === 'user' ? 'text-brand' : 'text-faint',
            ].join(' ')}
          >
            {line.tool ?? t(ROLE[line.role])}
          </span>
          {line.time > 0 && (
            <span className="ml-auto text-ui-xs text-faint tabular-nums">{clock(line.time)}</span>
          )}
          <IconButton
            icon={Bookmark}
            size="xs"
            label={t(marked ? 'organize.unbookmark' : 'organize.bookmark')}
            aria-pressed={marked}
            disabled={disabled}
            className={marked ? 'text-text' : 'text-faint'}
            onClick={() =>
              void useLibrary.getState().annotate(sessionId, {
                bookmarks: marked
                  ? item.bookmarks.filter((seq) => seq !== line.seq)
                  : [...item.bookmarks, line.seq],
              })
            }
          />
        </div>

        <p
          className={[
            'selectable break-words whitespace-pre-wrap',
            machine ? 'font-mono text-ui-sm' : 'text-ui-base leading-relaxed',
            line.role === 'context' ? 'text-faint' : machine ? 'text-muted' : 'text-text',
          ].join(' ')}
        >
          {shown ? line.text : head}
          {folded && !shown && '…'}
        </p>

        {folded && (
          <Button variant="ghost" size="xs" onClick={() => setShown(!shown)} className="mt-1 -ml-2">
            {shown ? t('sessions.collapse') : t('sessions.expand')}
          </Button>
        )}
        {!!line.attachments?.length && (
          <div className="mt-3 flex flex-col gap-2">
            <ul className="grid gap-2 sm:grid-cols-2" aria-label={t('sessions.attachments')}>
              {line.attachments.map((item, index) => {
                const AttachmentIcon = item.kind === 'image' ? Image : FileText
                return (
                  <li key={index} className="card flex min-w-0 items-start gap-3 px-4 py-3">
                    <AttachmentIcon
                      size={18}
                      strokeWidth={1.8}
                      className="mt-0.5 shrink-0 text-muted"
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="selectable break-words text-ui-base font-medium text-text">
                        {item.name || t(item.kind === 'image' ? 'sessions.image' : 'sessions.file')}
                      </p>
                      <p className="mt-0.5 break-words text-ui-sm text-faint">
                        {[
                          item.bytes !== null
                            ? item.bytes < 1000
                              ? `${item.bytes} B`
                              : filesize(item.bytes)
                            : null,
                          item.mediaType,
                          item.width && item.height ? `${item.width} × ${item.height}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {item.id && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setPreview(item)}
                          className="mt-2"
                        >
                          {t(
                            attachmentPreviewKind(item) === 'pdf'
                              ? 'sessions.previewPdf'
                              : item.kind === 'file'
                                ? 'sessions.previewFile'
                                : 'sessions.previewImage',
                          )}
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="text-ui-sm leading-relaxed text-muted">
              {t('sessions.attachmentNotice')}
            </p>
            {!!line.attachmentsOmitted && (
              <p className="text-ui-sm text-muted">
                {t('sessions.attachmentsOmitted', { n: line.attachmentsOmitted })}
              </p>
            )}
          </div>
        )}
        {preview && (
          <AttachmentPreview
            sessionId={sessionId}
            attachment={preview}
            onClose={() => setPreview(null)}
          />
        )}
      </div>
    </article>
  )
}

/** Which project the list is narrowed to, as the menu that narrows it. */
function Filter({
  project,
  reach,
  onPick,
}: {
  project: string | null
  reach: string[]
  onPick: (project: string | null) => void
}) {
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const entries: MenuEntry[] = [
      {
        label: t('sessions.allProjects'),
        selected: project === null,
        run: () => onPick(null),
      },
    ]

    if (reach.length > 0) entries.push(SEPARATOR)
    for (const path of reach) {
      entries.push({
        label: leaf(path),
        selected: path === project,
        run: () => onPick(path),
      })
    }

    const box = event.currentTarget.getBoundingClientRect()
    useMenu.getState().show(box.left, box.bottom + 4, entries)
  }

  return (
    <button
      type="button"
      aria-haspopup="menu"
      data-hint={project ?? t('sessions.filter')}
      aria-label={t('sessions.filter')}
      onClick={open}
      className="select-trigger max-w-[200px] shrink-0"
    >
      <span className="truncate">{project ? leaf(project) : t('sessions.allProjects')}</span>
      <ChevronDown size={14} strokeWidth={2} className="shrink-0 opacity-55" aria-hidden="true" />
    </button>
  )
}

function FilterTags({
  value,
  values,
  onChange,
}: {
  value: string
  values: string[]
  onChange: (value: string) => void
}) {
  return (
    <button
      type="button"
      className="select-trigger select-trigger--sm max-w-[180px]"
      aria-haspopup="menu"
      aria-label={t('organize.tags')}
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        useMenu.getState().show(
          box.left,
          box.bottom + 4,
          ['', ...values].map((tag) => ({
            label: tag || t('organize.allTags'),
            selected: tag === value,
            run: () => onChange(tag),
          })),
        )
      }}
    >
      <span className="truncate">{value || t('organize.allTags')}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  )
}

/**
 * Cut a long line down to something a list of them can be skimmed.
 *
 * A tool's output is the whole reason for the fold: one `Read` can be a file,
 * and eight unfolded of those is a pane nobody scrolls to the end of.
 */
function fold(text: string): { head: string; folded: boolean } {
  const rows = text.split('\n')
  if (rows.length <= PEEK_LINES && text.length <= PEEK_CHARS) return { head: text, folded: false }
  return { head: rows.slice(0, PEEK_LINES).join('\n').slice(0, PEEK_CHARS), folded: true }
}

/** The time of day a line was written, in the user's own clock. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

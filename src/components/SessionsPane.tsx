import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  ArrowLeft,
  Bot,
  Braces,
  Check,
  ChevronDown,
  ClipboardCopy,
  FileCode2,
  FileOutput,
  FileText,
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

import { Button } from '@/components/Button'
import { Empty } from '@/components/Empty'
import { PaneHeader } from '@/components/PaneHeader'
import { TabButton } from '@/components/TabButton'
import { UsageReport } from '@/components/UsageReport'
import { count, day, leaf, when } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { MessageKey } from '@/lib/i18n'
import type {
  Role,
  SessionCard,
  SessionFormat,
  SessionHit,
  SessionLine,
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

  const field = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  /** The line an opened session should land on, when a quote is what opened it. */
  const [anchor, setAnchor] = useState<number | null>(null)
  // The statement is a second reading of the same shelf, not a seventh pane in
  // the rail: nobody goes looking for "usage" without a session in mind, and a
  // rail that grows an entry per question stops being a rail.
  const [tab, setTab] = useState<'list' | 'usage'>('list')

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Emptying the box is not a keystroke to wait out — it is the moment the list
  // underneath becomes the answer again.
  useEffect(() => {
    const timer = window.setTimeout(() => void search(query), query === '' ? 0 : DEBOUNCE)
    return () => window.clearTimeout(timer)
  }, [query, search])

  const listed = useMemo(
    () => (cards ?? []).filter((card) => project === null || card.project === project),
    [cards, project],
  )

  const reach = useMemo(() => projects(cards ?? []), [cards])

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
        subtitle={tab === 'list' ? t('sessions.subtitle') : t('usage.subtitle')}
      >
        <div className="flex items-center gap-0.5 rounded-control bg-canvas-deep p-0.5 hairline">
          <TabButton
            label={t('sessions.tab.list')}
            active={tab === 'list'}
            onClick={() => setTab('list')}
          />
          <TabButton
            label={t('sessions.tab.usage')}
            active={tab === 'usage'}
            onClick={() => setTab('usage')}
          />
        </div>

        <Button
          variant="secondary"
          onClick={() => void refresh()}
          disabled={scanning}
          data-hint={t('sessions.refresh')}
          aria-label={t('sessions.refresh')}
        >
          <RefreshCw
            size={13}
            strokeWidth={2.2}
            className={scanning ? 'animate-spin' : undefined}
          />
        </Button>
      </PaneHeader>

      {tab === 'usage' ? (
        <UsageReport cards={listed} onOpen={(id) => show(id, null)} />
      ) : (
        <>
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
            <Search
              size={14}
              strokeWidth={2.1}
              className="shrink-0 text-faint"
              aria-hidden="true"
            />
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
              className="selectable h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-faint"
            />
            {searching && (
              <Loader2 size={13} className="shrink-0 animate-spin text-faint" aria-hidden="true" />
            )}
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

            <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line" />

            <Filter project={project} reach={reach} onPick={(picked) => void narrow(picked)} />
          </div>

          {listed.length > 0 && <Totals cards={listed} hits={hits} />}

          {error && <Warning message={error} />}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {hits ? (
              hits.length === 0 ? (
                <Empty
                  icon={Search}
                  message={
                    searching ? t('sessions.scanning') : t('sessions.noResults', { query: asked })
                  }
                  hint={searching ? undefined : t('sessions.noResultsHint')}
                />
              ) : (
                <ul>
                  {hits.map((hit) => (
                    <Entry
                      key={hit.card.id}
                      card={hit.card}
                      matches={hit.matches}
                      marks={hit.marks}
                      onOpen={(seq) => show(hit.card.id, seq)}
                    />
                  ))}
                </ul>
              )
            ) : listed.length === 0 ? (
              <Empty
                icon={scanning ? Loader2 : MessagesSquare}
                spin={scanning}
                message={scanning ? t('sessions.scanning') : t('sessions.empty')}
                hint={scanning ? undefined : t('sessions.emptyHint')}
              />
            ) : (
              <ul>
                {listed.map((card) => (
                  <Entry key={card.id} card={card} onOpen={() => show(card.id, null)} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}

/** Something that went wrong, said in place rather than over the top of anything. */
function Warning({ message }: { message: string }) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-danger/25 bg-danger/10 px-4 py-2">
      <TriangleAlert
        size={13}
        strokeWidth={2.1}
        className="mt-[2px] shrink-0 text-danger"
        aria-hidden="true"
      />
      <p className="selectable text-[11.5px] leading-relaxed text-muted">{message}</p>
    </div>
  )
}

/** What the shelf on screen adds up to — the answer to "where did it all go". */
function Totals({ cards, hits }: { cards: SessionCard[]; hits: SessionHit[] | null }) {
  const tokens = spent(cards)
  const turns = cards.reduce((sum, card) => sum + card.turns, 0)

  return (
    <div className="flex h-8 shrink-0 flex-wrap items-center gap-x-4 border-b border-line bg-canvas-deep/40 px-4 text-[11px] text-faint">
      <span className="tabular-nums">
        {hits
          ? t('sessions.found', { count: hits.length, total: cards.length })
          : t('sessions.count', { count: cards.length })}
      </span>
      <span className="tabular-nums">{t('sessions.turns', { count: turns })}</span>

      <span
        className="ml-auto flex items-center gap-3 tabular-nums"
        data-hint={t('sessions.spentHint')}
      >
        <Figure label={t('sessions.input')} value={tokens.input} />
        <Figure label={t('sessions.output')} value={tokens.output} />
        <Figure label={t('sessions.cached')} value={tokens.cacheRead} />
      </span>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <span className="text-faint/70">{label} </span>
      <span className="font-medium text-muted">{count(value)}</span>
    </span>
  )
}

interface EntryProps {
  card: SessionCard
  /** How many lines answered the search, on the rows a search produced. */
  matches?: number
  marks?: SessionMark[]
  onOpen: (seq: number | null) => void
}

/** One session in the list: what was asked, where, and what it cost. */
function Entry({ card, matches, marks, onOpen }: EntryProps) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen(null)
          }
        }}
        className="flex w-full flex-col gap-1.5 border-b border-line px-4 py-3 text-left transition-colors duration-100 hover:bg-surface-2/55"
      >
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text">
            {card.title || t('sessions.untitled')}
          </span>
          {card.delegated && (
            <span
              data-hint={t('sessions.delegatedHint')}
              className="shrink-0 rounded-full border border-line-strong px-1.5 text-[10px] leading-[15px] text-faint"
            >
              {t('sessions.delegated')}
            </span>
          )}
          <span className="shrink-0 text-[11px] text-faint tabular-nums">{when(card.touched)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
          <span className="truncate" data-hint={card.project || undefined}>
            {card.project ? leaf(card.project) : t('sessions.noProject')}
          </span>
          <span className="tabular-nums">{t('sessions.turns', { count: card.turns })}</span>
          <span className="tabular-nums">
            {count(card.tokens.input + card.tokens.output)} tokens
          </span>
          {matches !== undefined && (
            <span className="tabular-nums text-brand">
              {t('sessions.matches', { count: matches })}
            </span>
          )}
        </div>

        {marks && marks.length > 0 && (
          <ul className="mt-0.5 flex flex-col gap-1">
            {marks.map((mark, index) => (
              <li key={`${mark.seq}-${index}`}>
                <button
                  type="button"
                  data-hint={t('sessions.jump')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(mark.seq)
                  }}
                  className="flex w-full items-baseline gap-2 rounded-control border-l-2 border-line-strong bg-canvas-deep/60 py-1 pr-2 pl-2 text-left transition-colors duration-100 hover:border-brand hover:bg-canvas-deep"
                >
                  <span className="shrink-0 text-[10px] text-faint uppercase">
                    {mark.tool ?? t(ROLE[mark.role])}
                  </span>
                  {/* One line, cut at both ends by the native side, so a match
                      in the middle of a file dump still arrives as a sentence. */}
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">
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
  const error = useSessions((state) => state.error)
  const body = useRef<HTMLDivElement>(null)

  // The point of a search result is the moment inside the session, so arriving
  // at the top of a thousand-line transcript would be arriving nowhere.
  useEffect(() => {
    if (!lines || anchor === null) return
    body.current?.querySelector(`[data-seq="${anchor}"]`)?.scrollIntoView({ block: 'center' })
  }, [lines, anchor])

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
        title={card ? card.title || t('sessions.untitled') : t('sessions.opening')}
        subtitle={card?.project ? leaf(card.project) : undefined}
        subtitleHint={card?.project}
      >
        {card && <Export id={card.id} />}

        <Button variant="secondary" onClick={onBack}>
          <ArrowLeft size={13} strokeWidth={2.3} />
          {t('sessions.back')}
        </Button>
      </PaneHeader>

      {card && (
        <div className="flex h-8 shrink-0 flex-wrap items-center gap-x-4 border-b border-line bg-canvas-deep/40 px-5 text-[11px] text-faint">
          {card.started > 0 && (
            <span className="tabular-nums">{day(new Date(card.started).toISOString())}</span>
          )}
          <span className="tabular-nums">{t('sessions.turns', { count: card.turns })}</span>
          {card.models.map((model) => (
            <span key={model} className="truncate font-mono text-[10.5px]">
              {model}
            </span>
          ))}
          <Spend tokens={card.tokens} />
        </div>
      )}

      {error && <Warning message={error} />}

      <div ref={body} className="min-h-0 flex-1 overflow-y-auto">
        {lines ? (
          lines.map((line, index) => (
            <Turn key={`${line.seq}-${index}`} line={line} lit={line.seq === anchor} />
          ))
        ) : (
          <Empty icon={Loader2} spin message={t('sessions.opening')} />
        )}
      </div>
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
    useMenu.getState().show(box.left, box.bottom + 6, entries)
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
        <Loader2 size={13} className="animate-spin" aria-hidden="true" />
      ) : done ? (
        <Check size={13} strokeWidth={2.4} className="text-ok" aria-hidden="true" />
      ) : (
        <FileOutput size={13} strokeWidth={2.2} aria-hidden="true" />
      )}
      {t('sessions.export')}
    </Button>
  )
}

function Spend({ tokens }: { tokens: Tokens }) {
  return (
    <span
      className="ml-auto flex items-center gap-3 tabular-nums"
      data-hint={t('sessions.spentHint')}
    >
      <Figure label={t('sessions.input')} value={tokens.input} />
      <Figure label={t('sessions.output')} value={tokens.output} />
      <Figure label={t('sessions.cached')} value={tokens.cacheRead} />
    </span>
  )
}

/** One line of the transcript, long ones folded until asked for. */
function Turn({ line, lit }: { line: SessionLine; lit: boolean }) {
  const [shown, setShown] = useState(false)
  const Icon = MARKER[line.role]
  const machine = line.role === 'tool'
  const { head, folded } = fold(line.text)

  return (
    <article
      data-seq={line.seq}
      className={[
        'border-b border-l-2 border-b-line/60 px-5 py-2.5',
        RAIL[line.role],
        lit ? 'bg-brand/[0.11]' : '',
      ].join(' ')}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <Icon
          size={11}
          strokeWidth={2.2}
          className={line.role === 'user' ? 'text-brand' : 'text-faint'}
          aria-hidden="true"
        />
        <span
          className={[
            'text-[10.5px] leading-none font-semibold tracking-[0.05em]',
            line.role === 'user' ? 'text-brand' : 'text-faint',
          ].join(' ')}
        >
          {line.tool ?? t(ROLE[line.role])}
        </span>
        {line.time > 0 && (
          <span className="ml-auto text-[10.5px] leading-none text-faint/70 tabular-nums">
            {clock(line.time)}
          </span>
        )}
      </div>

      <p
        className={[
          'selectable break-words whitespace-pre-wrap',
          machine
            ? 'font-mono text-[11.5px] leading-[1.6] text-muted'
            : 'text-[12.5px] leading-relaxed',
          line.role === 'context' ? 'text-faint' : 'text-text',
        ].join(' ')}
      >
        {shown ? line.text : head}
        {folded && !shown && '…'}
      </p>

      {folded && (
        <button
          type="button"
          onClick={() => setShown(!shown)}
          className="mt-1.5 text-[11px] text-brand transition-opacity duration-100 hover:opacity-75"
        >
          {shown ? t('sessions.collapse') : t('sessions.expand')}
        </button>
      )}
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
        icon: project === null ? Check : undefined,
        run: () => onPick(null),
      },
    ]

    if (reach.length > 0) entries.push(SEPARATOR)
    for (const path of reach) {
      entries.push({
        label: leaf(path),
        icon: path === project ? Check : undefined,
        run: () => onPick(path),
      })
    }

    const box = event.currentTarget.getBoundingClientRect()
    useMenu.getState().show(box.left, box.bottom + 6, entries)
  }

  return (
    <button
      type="button"
      aria-haspopup="menu"
      data-hint={project ?? t('sessions.filter')}
      aria-label={t('sessions.filter')}
      onClick={open}
      className="inline-flex h-[22px] max-w-[168px] shrink-0 items-center gap-1.5 rounded-control border border-line px-1.5 text-[11.5px] text-muted transition-colors duration-100 hover:border-line-strong hover:bg-surface-2 hover:text-text"
    >
      <span className="truncate">{project ? leaf(project) : t('sessions.allProjects')}</span>
      <ChevronDown size={10} strokeWidth={2.4} className="shrink-0 opacity-55" aria-hidden="true" />
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

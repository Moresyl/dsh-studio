import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import {
  AppWindow,
  Check,
  CornerDownLeft,
  History,
  Layers,
  Loader2,
  Moon,
  Play,
  Puzzle,
  RotateCw,
  Search,
  SearchX,
  Square,
  Sun,
  SunMoon,
  type LucideIcon,
} from 'lucide-react'

import { Empty } from '@/components/Empty'
import { SETTINGS, SETTINGS_KEYS, VIEWS, type View } from '@/components/workbench-contract'
import { leaf, when } from '@/lib/format'
import { fuzzy, segments } from '@/lib/fuzzy'
import { t, type MessageKey } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { pressedBackdrop } from '@/lib/modal'
import { ACCELERATOR, SHIFT } from '@/lib/platform'
import { useHarness } from '@/state/harness'
import { usePalette } from '@/state/palette'
import { usePlugins } from '@/state/plugins'
import { switchProfile, useProfiles } from '@/state/profiles'
import { useSessions } from '@/state/sessions'
import { useTheme, type Theme } from '@/state/theme'

/**
 * How many sessions the unsearched list offers.
 *
 * The palette opens on what someone would reach for without typing, and a
 * machine with four hundred sessions on it does not have four hundred things
 * anybody wants unprompted. Typing lifts the cap — that is what the box is for.
 */
const RECENT = 6

/**
 * How many matches a search draws.
 *
 * Not a limit on what is searched — every session on the disk is ranked against
 * the query, and this only bounds what is put in the DOM. Past forty rows the
 * list has stopped being a set of answers and become a haystack; the sessions
 * pane is where an exhaustive search belongs, and it quotes the matching line.
 */
const LIMIT = 40

/** What this prints for the new-window key, on either platform. */
const NEW_WINDOW_KEYS = `${ACCELERATOR}${SHIFT}N`

const THEMES: { id: Theme; icon: LucideIcon; label: MessageKey }[] = [
  { id: 'system', icon: SunMoon, label: 'theme.system' },
  { id: 'light', icon: Sun, label: 'theme.light' },
  { id: 'dark', icon: Moon, label: 'theme.dark' },
]

/** One row: a name, what it does, and where it belongs when nothing is typed. */
interface Command {
  id: string
  group: MessageKey
  icon: LucideIcon
  label: string
  /** Faint text at the right edge — an accelerator, a time, a state. */
  hint?: string
  /** Already the case, so the row shows a tick instead of promising a change. */
  active?: boolean
  run: () => void
}

/**
 * Everything this window can do, behind one keystroke.
 *
 * The rest of the shell is arranged for the hand: a rail to click, a header to
 * put a button in, a menu under the right mouse button. All of that assumes the
 * user knows where the thing they want lives. The palette assumes the opposite —
 * that they know its name — and that is the assumption that scales, because the
 * number of things this app can do keeps growing and the rail does not.
 *
 * So it is deliberately not a launcher for a curated handful. It carries the
 * views, the service, every profile on the machine, every installed plugin and
 * every session on the disk, because a palette that answers half of what is
 * typed into it teaches people to stop typing into it.
 *
 * Two rules make it feel like one thing rather than a list of lists. Nothing
 * typed shows the groups, in the order somebody would reach for them, so the
 * first frame is a map of the application. Anything typed drops the headings and
 * ranks the lot together, because at that point the user is aiming, and a
 * heading between them and their target is furniture.
 */
export function CommandPalette(props: {
  onView: (view: View) => void
  onManageProfiles: () => void
}) {
  const open = usePalette((state) => state.open)

  // Mounted on open rather than hidden, which is what makes an empty box and a
  // selection on the first row the state it opens in — no effect resetting last
  // time's query, and nothing subscribed to a roster while it is not on screen.
  return open ? <Palette {...props} /> : null
}

function Palette({
  onView,
  onManageProfiles,
}: {
  onView: (view: View) => void
  onManageProfiles: () => void
}) {
  const hide = usePalette((state) => state.hide)

  const phase = useHarness((state) => state.status.phase)
  const busy = useHarness((state) => state.busy)
  const roster = useProfiles((state) => state.roster)
  const refreshProfiles = useProfiles((state) => state.refresh)
  const installed = usePlugins((state) => state.profile?.plugins)
  const togglePlugin = usePlugins((state) => state.toggle)
  const cards = useSessions((state) => state.cards)
  const scanning = useSessions((state) => state.scanning)
  const refreshSessions = useSessions((state) => state.refresh)
  const theme = useTheme((state) => state.theme)
  const chooseTheme = useTheme((state) => state.choose)

  const list = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  // Two lists this window can be opened without ever having visited the pane
  // that loads them, and a palette that offered no profiles because the manager
  // has not been opened yet would be wrong in a way the user cannot see. Read
  // through the store rather than from the props above, so a list that landed
  // between mount and this effect is not fetched a second time.
  useEffect(() => {
    if (useProfiles.getState().roster === null) void refreshProfiles()
    if (useSessions.getState().cards === null) void refreshSessions()
  }, [refreshProfiles, refreshSessions])

  // Handed back on the way out: a palette that ate the caret would cost the user
  // the field they were typing in when they reached for it.
  useEffect(() => {
    const previous = document.activeElement
    field.current?.focus()

    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  const running = phase === 'ready' || phase === 'starting' || phase === 'restarting'

  const commands = useMemo<Command[]>(() => {
    const all: Command[] = []
    const close = (run: () => void) => () => {
      hide()
      run()
    }

    for (const [index, view] of VIEWS.entries()) {
      all.push({
        id: `go:${view.id}`,
        group: 'palette.group.go',
        icon: view.icon,
        label: t(view.label),
        hint: `${ACCELERATOR}${index + 1}`,
        run: close(() => onView(view.id)),
      })
    }

    // Appended rather than iterated, because it is off the numbered run.
    all.push({
      id: `go:${SETTINGS.id}`,
      group: 'palette.group.go',
      icon: SETTINGS.icon,
      label: t(SETTINGS.label),
      hint: SETTINGS_KEYS,
      run: close(() => onView(SETTINGS.id)),
    })

    // The one command here that does not act on this window. It is closed first
    // all the same: the palette belongs to the window it was opened in, and
    // leaving it standing behind a window that has just taken the focus is a
    // modal the user has to come back and dismiss.
    all.push({
      id: 'window:new',
      group: 'palette.group.window',
      icon: AppWindow,
      label: t('window.new'),
      hint: NEW_WINDOW_KEYS,
      run: close(() => void ipc.windowOpen()),
    })

    // Offered by what the supervisor last said, not by what a click implied: a
    // palette that lists "Start" beside a harness that is already up is a
    // palette somebody stops reading.
    if (!busy) {
      if (!running) {
        all.push({
          id: 'service:start',
          group: 'palette.group.service',
          icon: Play,
          label: t('action.start'),
          run: close(() => void useHarness.getState().start()),
        })
      } else {
        all.push({
          id: 'service:stop',
          group: 'palette.group.service',
          icon: Square,
          label: t('action.stop'),
          run: close(() => void useHarness.getState().stop()),
        })
      }

      if (phase === 'ready') {
        all.push({
          id: 'service:restart',
          group: 'palette.group.service',
          icon: RotateCw,
          label: t('palette.restart'),
          run: close(() => {
            void useHarness
              .getState()
              .stop()
              .then(() => useHarness.getState().start())
          }),
        })
      }
    }

    // Every profile, including the one already in use — which `switchProfile`
    // answers by doing nothing, so the row is a statement of where the window is
    // pointed rather than a change waiting to be made by mistake.
    for (const profile of roster?.profiles ?? []) {
      const chosen = profile.name === roster?.selected
      all.push({
        id: `profile:${profile.name}`,
        group: 'palette.group.profile',
        icon: Layers,
        label: t('palette.switch', { name: profile.name }),
        hint: chosen ? t('palette.current') : undefined,
        active: chosen,
        run: close(() => void switchProfile(profile.name)),
      })
    }

    all.push({
      id: 'profile:manage',
      group: 'palette.group.profile',
      icon: Layers,
      label: t('profile.manage'),
      run: close(onManageProfiles),
    })

    all.push({
      id: 'plugins:market',
      group: 'palette.group.plugins',
      icon: Puzzle,
      label: t('palette.market'),
      run: close(() => onView('plugins')),
    })

    // Built-ins are in the stack because the profile template put them there, and
    // libraries declare no layer to take out of it — neither is a switch, so
    // neither is a command.
    for (const plugin of installed ?? []) {
      if (plugin.builtin || (!plugin.active && !plugin.disabled)) continue
      all.push({
        id: `plugin:${plugin.name}`,
        group: 'palette.group.plugins',
        icon: Puzzle,
        label: `${plugin.disabled ? t('plugins.enable') : t('plugins.disable')} ${plugin.name}`,
        hint: plugin.disabled ? t('plugins.off') : t('plugins.on'),
        run: close(() => void togglePlugin(plugin.name, plugin.disabled)),
      })
    }

    // Every session on the disk, not a recent handful: the shelf is the largest
    // thing this palette reaches, and a search that quietly skipped most of it
    // would answer "no such session" about one somebody is looking straight at.
    // Only what is drawn unasked is capped, and that happens further down.
    for (const session of cards ?? []) {
      all.push({
        id: `session:${session.id}`,
        group: 'palette.group.session',
        icon: History,
        label: session.title || t('sessions.untitled'),
        hint: [session.project && leaf(session.project), when(session.touched)]
          .filter(Boolean)
          .join(' · '),
        run: close(() => {
          onView('sessions')
          void useSessions.getState().open(session.id)
        }),
      })
    }

    for (const entry of THEMES) {
      all.push({
        id: `theme:${entry.id}`,
        group: 'palette.group.view',
        icon: entry.icon,
        label: t(entry.label),
        active: theme === entry.id,
        run: close(() => chooseTheme(entry.id)),
      })
    }

    return all
  }, [
    hide,
    onView,
    onManageProfiles,
    busy,
    running,
    phase,
    roster,
    installed,
    togglePlugin,
    cards,
    theme,
    chooseTheme,
  ])

  /** What survived the query, best first, each with the letters it matched. */
  const shown = useMemo(() => {
    const asked = query.trim()

    // Nothing asked, so nothing is being looked for: the list is an offer, and an
    // offer of every session ever opened is a wall. The rest are one keystroke
    // away and the search below reaches all of them.
    if (asked === '') {
      let sessions = 0
      return commands
        .filter((command) => command.group !== 'palette.group.session' || ++sessions <= RECENT)
        .map((command) => ({ command, at: [] as number[] }))
    }

    const ranked: { command: Command; score: number; at: number[] }[] = []
    for (const command of commands) {
      const match = fuzzy(asked, command.label)
      if (match) ranked.push({ command, score: match.score, at: match.at })
    }

    return ranked.sort((left, right) => right.score - left.score).slice(0, LIMIT)
  }, [commands, query])

  // In the same frame it moves: a row that scrolls into view a frame late reads
  // as the list lagging behind the key. Keyed on the query as well, because a
  // narrowed list leaves the selection on row 0 of somewhere else entirely.
  useLayoutEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, query])

  const current = shown[active]

  // Typing changes what the first row is, and the selection follows it — done
  // here rather than in an effect watching the query, because this is the one
  // place the query changes and a render spent catching up is a render wasted.
  const ask = (asked: string) => {
    setQuery(asked)
    setActive(0)
  }

  const step = (direction: 1 | -1) => {
    if (shown.length === 0) return
    setActive((current) => (current + direction + shown.length) % shown.length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      // Stopped here: the search field this card is drawn over answers Escape by
      // clearing itself, and the palette in front of it is what the key is for.
      event.stopPropagation()
      hide()
      return
    }

    // Tab moves the selection rather than the caret, because the caret has
    // nowhere better to be — every row is reachable from the box it is filtered
    // by, and a Tab that walked out of the field would cost the next keystroke.
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault()
      step(1)
      return
    }
    if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault()
      step(-1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setActive(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setActive(Math.max(shown.length - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      if (!current) return
      event.preventDefault()
      current.command.run()
    }
  }

  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => pressedBackdrop(event, hide)

  const grouped = query.trim() === ''
  const waiting = scanning && cards === null

  return (
    <div
      role="presentation"
      onMouseDown={onBackdrop}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-30 flex animate-fade justify-center bg-canvas-deep/65 px-8 pt-[11vh] backdrop-blur-[2px]"
    >
      {/* No focus ring to hold: the box is the only thing in here the caret can
          reach, and Tab is spent moving the selection instead of leaving. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        className="flex h-fit max-h-[68vh] w-full max-w-[588px] animate-pop flex-col overflow-hidden rounded-panel border border-line-strong bg-surface shadow-lift"
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3.5">
          <Search size={15} strokeWidth={2.1} className="shrink-0 text-faint" aria-hidden="true" />
          <input
            ref={field}
            aria-label={t('palette.search')}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="palette-list"
            aria-activedescendant={current ? `palette-${current.command.id}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => ask(event.target.value)}
            placeholder={t('palette.search')}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-faint"
          />
          <kbd className="shrink-0 rounded-[4px] border border-line px-1.5 py-px font-sans text-[10.5px] text-faint">
            {ACCELERATOR}K
          </kbd>
        </div>

        {shown.length === 0 ? (
          <div className="py-2">
            <Empty
              icon={waiting ? Loader2 : SearchX}
              spin={waiting}
              message={waiting ? t('palette.scanning') : t('palette.empty')}
              hint={waiting ? undefined : t('palette.emptyHint')}
            />
          </div>
        ) : (
          <div
            ref={list}
            id="palette-list"
            role="listbox"
            aria-label={t('palette.title')}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5"
          >
            {shown.map((row, index) => (
              <Row
                key={row.command.id}
                command={row.command}
                at={row.at}
                // The heading belongs to the first row of its run rather than to
                // a wrapper, so the list stays one flat set of children and the
                // index the keyboard moves through is the index in the DOM.
                heading={
                  grouped && row.command.group !== shown[index - 1]?.command.group
                    ? t(row.command.group)
                    : undefined
                }
                active={index === active}
                onHover={() => setActive(index)}
              />
            ))}
          </div>
        )}

        <div className="flex h-8 shrink-0 items-center gap-4 border-t border-line bg-canvas-deep/40 px-3.5">
          <Legend keys="↑↓" label={t('palette.move')} />
          <Legend icon={CornerDownLeft} label={t('palette.run')} />
          <Legend keys="Esc" label={t('palette.close')} />
        </div>
      </div>
    </div>
  )
}

interface RowProps {
  command: Command
  /** Which letters of the label the query landed on. */
  at: number[]
  heading?: string
  active: boolean
  onHover: () => void
}

function Row({ command, at, heading, active, onHover }: RowProps) {
  const Icon = command.icon

  return (
    // Presentational so the option below still reads as a direct child of the
    // listbox: the wrapper exists to give the keyboard one element per row to
    // scroll, and the heading is a sighted reader's grouping — every option
    // already says in full what it does.
    <div role="presentation">
      {heading && (
        <p aria-hidden="true" className="caption px-3.5 pt-2 pb-1">
          {heading}
        </p>
      )}

      <div
        id={`palette-${command.id}`}
        role="option"
        aria-selected={active}
        onMouseMove={onHover}
        // On the press and without taking focus: the caret stays in the box, so
        // a click that turns out to be the wrong row costs nothing to correct.
        onMouseDown={(event) => {
          event.preventDefault()
          command.run()
        }}
        className={[
          'mx-1.5 flex h-[34px] cursor-pointer items-center gap-2.5 rounded-control px-2 transition-colors duration-75',
          active ? 'bg-surface-2 text-text' : 'text-muted',
        ].join(' ')}
      >
        <Icon
          size={14}
          strokeWidth={2}
          className={`shrink-0 ${active ? 'text-brand' : 'text-faint'}`}
          aria-hidden="true"
        />

        <span className="min-w-0 flex-1 truncate text-[12.5px]">
          {segments(command.label, at).map((part, index) =>
            part.hit ? <mark key={index}>{part.text}</mark> : part.text,
          )}
        </span>

        {command.active && (
          <Check size={13} strokeWidth={2.4} className="shrink-0 text-ok" aria-hidden="true" />
        )}
        {command.hint && (
          <span className="max-w-[42%] shrink-0 truncate text-[11px] text-faint">
            {command.hint}
          </span>
        )}
      </div>
    </div>
  )
}

/** One key and what it does, along the bottom edge. */
function Legend({ keys, icon: Icon, label }: { keys?: string; icon?: LucideIcon; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[10.5px] text-faint">
      <kbd className="grid h-[15px] min-w-[16px] place-items-center rounded-[4px] border border-line px-1 font-sans text-[10px] text-muted">
        {Icon ? <Icon size={9} strokeWidth={2.4} aria-hidden="true" /> : keys}
      </kbd>
      {label}
    </span>
  )
}

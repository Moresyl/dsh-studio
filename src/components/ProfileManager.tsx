import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  ArrowLeftRight,
  Boxes,
  Check,
  ChevronDown,
  Copy,
  FileInput,
  FileOutput,
  Info,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { open as pickFile, save as pickPath } from '@tauri-apps/plugin-dialog'

import { Badge, type BadgeTone } from '@/components/Badge'
import { Button } from '@/components/Button'
import { Empty } from '@/components/Empty'
import { IconButton } from '@/components/IconButton'
import { Segmented } from '@/components/Segmented'
import { t } from '@/lib/i18n'
import type { Comparison, Difference, Profile, Standing } from '@/lib/ipc'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { ask } from '@/state/dialog'
import { reportAction } from '@/state/failure'
import { useHarness } from '@/state/harness'
import { contextMenu, SEPARATOR, useMenu, type MenuEntry } from '@/state/menu'
import { isNewProfileName, switchProfile, useProfiles } from '@/state/profiles'

interface ProfileManagerProps {
  onClose: () => void
}

type Tab = 'list' | 'compare'

/** The four things the one name field is ever asking for. */
type Form =
  | { kind: 'create' }
  | { kind: 'duplicate'; source: string }
  | { kind: 'rename'; from: string }
  | { kind: 'import'; path: string; from: string; plugins: number; verified: boolean }

/**
 * Everything a profile is, in one place.
 *
 * A dialog rather than a sixth view in the rail, and mounted at the root rather
 * than in the title bar that opens it. Which profile the window works in is a
 * question that comes up *while* using one of the views — the plugin panel is a
 * panel of a profile, the terminal runs inside one — so the answer has to be
 * reachable without leaving whatever raised the question, and it has to cover
 * the window rather than replace what is underneath it.
 *
 * Two tabs, because there are two questions. Which profiles exist and what is in
 * them is the first; the second is the one nobody else answers — what actually
 * differs between two of them. That comparison is the reason a profile is worth
 * copying at all: you keep a working stack, you copy it, you add one plugin to
 * the copy, and a week later the only thing you need to know is which one.
 */
export function ProfileManager({ onClose }: ProfileManagerProps) {
  const roster = useProfiles((state) => state.roster)
  const working = useProfiles((state) => state.working)
  const comparison = useProfiles((state) => state.comparison)
  const comparing = useProfiles((state) => state.comparing)
  const error = useProfiles((state) => state.error)
  const note = useProfiles((state) => state.note)
  const refresh = useProfiles((state) => state.refresh)
  const create = useProfiles((state) => state.create)
  const duplicate = useProfiles((state) => state.duplicate)
  const rename = useProfiles((state) => state.rename)
  const drop = useProfiles((state) => state.remove)
  const write = useProfiles((state) => state.save)
  const read = useProfiles((state) => state.read)
  const load = useProfiles((state) => state.load)
  const compare = useProfiles((state) => state.compare)
  const settle = useProfiles((state) => state.settle)

  // Copying and importing run a package manager, and it reports through the
  // supervisor's log — so the tail of that log is this dialog's progress line.
  const latest = useHarness((state) => state.lines.at(-1)?.line ?? '')

  const [tab, setTab] = useState<Tab>('list')
  const [form, setForm] = useState<Form | null>(null)
  const [pair, setPair] = useState<{ left: string; right: string } | null>(null)

  const card = useRef<HTMLDivElement>(null)

  // Read again on arrival: this opens from a menu that may have been looking at
  // the roster for a while. The last error goes with the dialog rather than
  // waiting in the store for the next time it is opened.
  useEffect(() => {
    void refresh()
    return settle
  }, [refresh, settle])

  // Keys are answered by the card, so the card is where focus starts — and
  // wherever it was, a row or the title bar's chip, is where it goes back to.
  useEffect(() => {
    const previous = document.activeElement
    card.current?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  // Both sides are held loosely: a comparison of a profile that has since been
  // renamed or deleted is not a comparison, so a pick that is no longer a name
  // falls back to the profile this window is on.
  const { left, right, names } = useMemo(() => {
    const names = roster?.profiles.map((profile) => profile.name) ?? []
    const left =
      pair && names.includes(pair.left) ? pair.left : (roster?.selected ?? names[0] ?? '')
    const right =
      pair && pair.right !== left && names.includes(pair.right)
        ? pair.right
        : (names.find((name) => name !== left) ?? '')
    return { left, right, names }
  }, [pair, roster])

  // Asked for on the way in and after anything that could have changed either
  // side. The roster object is replaced by every change rather than patched, so
  // it is the honest dependency here even though the two names are the input.
  useEffect(() => {
    if (tab !== 'compare' || !left || !right) return
    void compare(left, right)
  }, [tab, left, right, roster, compare])

  const exportProfile = useCallback(
    async (name: string) => {
      const path = await reportAction(
        async () =>
          await pickPath({
            title: t('profile.exportTitle'),
            defaultPath: `${name}.dsh-profile.json`,
            filters: [{ name: t('profile.fileKind'), extensions: ['json'] }],
          }),
      )
      if (path) await write(name, path)
    },
    [write],
  )

  const importProfile = useCallback(async () => {
    const path = await reportAction(
      async () =>
        await pickFile({
          title: t('profile.importTitle'),
          filters: [{ name: t('profile.fileKind'), extensions: ['json'] }],
        }),
    )
    if (typeof path !== 'string') return

    // Read before importing: the file carries the name it was exported under,
    // which is the name to offer — and a file that is not one of these should
    // say so before a directory is made for it.
    const file = await read(path)
    if (file) {
      setForm({
        kind: 'import',
        path,
        from: file.name,
        plugins: Object.keys(file.plugins).length,
        verified: file.verified,
      })
    }
  }, [read])

  const confirmRemove = useCallback(
    async (name: string) => {
      const taken = await ask({
        title: t('profile.confirmRemove'),
        body: t('profile.confirmRemoveBody'),
        subject: name,
        confirm: t('profile.remove'),
      })
      if (taken) await drop(name)
    },
    [drop],
  )

  const submit = async (name: string): Promise<void> => {
    if (!form) return

    const done = await (form.kind === 'create'
      ? create(name)
      : form.kind === 'duplicate'
        ? duplicate(form.source, name)
        : form.kind === 'rename'
          ? rename(form.from, name)
          : load(form.path, name))

    // Left open on failure, with the name still in the field: what fails here is
    // nearly always the name itself, and retyping it is not what should be
    // needed to fix one.
    if (done) setForm(null)
  }

  /**
   * What can be done to one profile.
   *
   * The two the harness ships templates for keep their entries and lose the two
   * that would delete them, because a menu whose shape depends on the row is a
   * menu nobody learns the position of.
   */
  const actions = (profile: Profile): MenuEntry[] => [
    {
      label: t('profile.duplicate'),
      icon: Copy,
      run: () => setForm({ kind: 'duplicate', source: profile.name }),
    },
    {
      label: t('profile.rename'),
      icon: Pencil,
      disabled: profile.shipped,
      run: () => setForm({ kind: 'rename', from: profile.name }),
    },
    {
      label: t('profile.export'),
      icon: FileOutput,
      run: () => void exportProfile(profile.name),
    },
    SEPARATOR,
    {
      label: t('profile.remove'),
      icon: Trash2,
      danger: true,
      disabled: profile.shipped,
      run: () => void confirmRemove(profile.name),
    },
  ]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A form is the thing in front while one is open, so it is what Escape
    // closes — the dialog behind it is still where the user meant to be.
    if (event.key === 'Escape' && form !== null) {
      event.stopPropagation()
      setForm(null)
      return
    }
    holdFocus(card.current, event, onClose)
  }

  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => pressedBackdrop(event, onClose)

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
        aria-label={t('profile.title')}
        tabIndex={-1}
        className="dialog-panel flex max-h-[min(720px,calc(100vh-64px))] min-h-[min(416px,calc(100vh-64px))] w-full max-w-[620px] animate-pop flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lift outline-none"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-4">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-brand"
          >
            <Layers size={18} strokeWidth={1.9} />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-ui-lg font-semibold text-text">{t('profile.title')}</h2>
            {/* The root is the tooltip rather than the line, because a profile
                being a directory matters exactly once — when looking for it. */}
            <p className="truncate text-ui-sm text-faint" data-hint={roster?.root}>
              {t('profile.subtitle')}
            </p>
          </div>

          <IconButton icon={X} label={t('profile.close')} onClick={onClose} />
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-2">
          <Segmented
            size="sm"
            label={t('profile.title')}
            value={tab}
            onChange={setTab}
            items={[
              { value: 'list', label: t('profile.tab.list') },
              { value: 'compare', label: t('profile.tab.compare') },
            ]}
          />

          {tab === 'list' ? (
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void importProfile()}
                disabled={working !== null}
              >
                <FileInput aria-hidden="true" />
                {t('profile.importFile')}
              </Button>
              {/* One primary to a dialog: while a form is open, the button that
                  finishes it is the one this window is waiting for. */}
              <Button
                variant={form === null ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setForm({ kind: 'create' })}
                disabled={working !== null}
              >
                <Plus aria-hidden="true" />
                {t('profile.new')}
              </Button>
            </div>
          ) : (
            <span className="ml-auto shrink-0 text-ui-sm text-faint tabular-nums">
              {comparing
                ? t('profile.comparing')
                : comparison && comparison.differences > 0
                  ? comparison.differences === 1
                    ? t('profile.differOne')
                    : t('profile.differMany', { count: comparison.differences })
                  : ''}
            </span>
          )}
        </div>

        {form && (
          <NameForm
            key={identity(form)}
            form={form}
            busy={working !== null}
            onCancel={() => setForm(null)}
            onSubmit={submit}
          />
        )}

        {(error || note) && (
          <div className="shrink-0 border-b border-line px-5 py-3">
            {error ? (
              <Notice tone="danger" icon={TriangleAlert}>
                {error}
              </Notice>
            ) : (
              <Notice tone="ok" icon={Check}>
                {note}
              </Notice>
            )}
          </div>
        )}

        {/* One height for both tabs: switching between them should move the
            content, not the window. The floor is the panel's rather than this
            region's, so a form and a message stacked above it make the body
            scroll instead of pushing the footer out of a short window. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {tab === 'list' ? (
            <List
              profiles={roster?.profiles ?? []}
              selected={roster?.selected ?? ''}
              working={working}
              onUse={(name) => void switchProfile(name)}
              actions={actions}
            />
          ) : (
            <Compare
              names={names}
              left={left}
              right={right}
              comparison={comparison}
              comparing={comparing}
              onPick={(side, name) =>
                setPair(side === 'left' ? { left: name, right } : { left, right: name })
              }
            />
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          {working !== null ? (
            <>
              <Loader2 size={14} className="shrink-0 animate-spin text-brand" aria-hidden="true" />
              <p className="min-w-0 flex-1 truncate font-mono text-ui-sm text-faint">
                {latest || working}
              </p>
            </>
          ) : (
            <>
              <Info size={14} strokeWidth={2} className="shrink-0 text-faint" aria-hidden="true" />
              <p className="min-w-0 flex-1 truncate text-ui-sm text-faint">
                {t('profile.restartNote')}
              </p>
            </>
          )}

          <Button variant="secondary" onClick={onClose}>
            {t('profile.close')}
          </Button>
        </footer>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface ListProps {
  profiles: Profile[]
  selected: string
  working: string | null
  onUse: (name: string) => void
  actions: (profile: Profile) => MenuEntry[]
}

function List({ profiles, selected, working, onUse, actions }: ListProps) {
  if (profiles.length === 0) {
    return <Blank icon={Boxes} message={t('profile.empty')} hint={t('profile.emptyHint')} />
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <ul className="list-card">
        {profiles.map((profile) => {
          const hosted = profile.name === selected
          const busy = working === profile.name
          const menu = () => actions(profile)

          // The profile this window is on is the filled row, and says so in a
          // badge as well: a fill alone is a colour, and a colour is not a word.
          return (
            <li
              key={profile.name}
              onContextMenu={contextMenu(menu)}
              className={['list-row list-row--roomy', hosted ? 'bg-surface-2' : ''].join(' ')}
            >
              <span
                aria-hidden="true"
                className={[
                  'grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-control-fill',
                  hosted ? 'text-brand' : 'text-faint',
                ].join(' ')}
              >
                <Boxes size={16} strokeWidth={1.9} />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span
                    data-hint={profile.dir}
                    className="truncate text-ui-base font-medium text-text"
                  >
                    {profile.name}
                  </span>
                  {profile.shipped && <Badge>{t('profile.builtinTag')}</Badge>}
                </div>

                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ui-sm text-faint">
                  <span className="tabular-nums">
                    {profile.plugins > 0
                      ? t('profile.installedCount', { count: profile.plugins })
                      : t('profile.noPlugins')}
                  </span>
                  {profile.disabled > 0 && (
                    <span className="tabular-nums">
                      {t('profile.offCount', { count: profile.disabled })}
                    </span>
                  )}
                  {!profile.initialized && (
                    <span className="text-warn">{t('profile.uninitialized')}</span>
                  )}
                  {/* Reported here rather than found out after switching, which is
                      the version of this where the window comes back empty. */}
                  {profile.initialized && !profile.servesWindow && (
                    <span data-hint={t('profile.noInterfaceNote')} className="text-warn">
                      {t('profile.noInterfaceTag')}
                    </span>
                  )}
                </div>
              </div>

              {hosted ? (
                <Badge tone="ok">
                  <Check aria-hidden="true" />
                  {t('profile.inUse')}
                </Badge>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onUse(profile.name)}
                  disabled={working !== null}
                >
                  {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                  {t('profile.use')}
                </Button>
              )}

              <IconButton
                icon={MoreHorizontal}
                label={t('profile.actions')}
                aria-haspopup="menu"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  useMenu.getState().show(box.left, box.bottom + 4, menu())
                }}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface CompareProps {
  names: string[]
  left: string
  right: string
  comparison: Comparison | null
  comparing: boolean
  onPick: (side: 'left' | 'right', name: string) => void
}

/** The three columns, shared by the header and every row under it. */
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_96px_96px] items-center gap-2'

/**
 * Two profiles, package by package.
 *
 * The rows arrive with what differs first, so the answer is at the top and the
 * agreement is underneath it rather than missing — "these two also share these
 * four" is part of the answer. A package can differ four ways, and the pills say
 * which: only one side has it, one side has it switched off, one side carries it
 * as a plain dependency, or both have it at different versions.
 */
function Compare({ names, left, right, comparison, comparing, onPick }: CompareProps) {
  if (names.length < 2 || !left || !right) {
    return <Blank icon={ArrowLeftRight} message={t('profile.needTwo')} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
        <SidePicker
          label={t('profile.left')}
          value={left}
          options={names.filter((name) => name !== right)}
          onPick={(name) => onPick('left', name)}
        />
        <ArrowLeftRight size={14} strokeWidth={2} className="shrink-0 text-faint" aria-hidden="true" />
        <SidePicker
          label={t('profile.right')}
          value={right}
          options={names.filter((name) => name !== left)}
          onPick={(name) => onPick('right', name)}
        />
      </div>

      {comparison === null ? (
        <Blank icon={Loader2} message={t('profile.comparing')} spin={comparing} />
      ) : comparison.rows.length === 0 ? (
        <Blank icon={Boxes} message={t('profile.identical')} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {comparison.differences === 0 && (
            <Notice tone="ok" icon={Check} className="mb-3">
              {t('profile.identical')}
            </Notice>
          )}

          {/* Clipped rather than hidden: `overflow: hidden` would make the card
              the thing the header sticks to, and the card does not scroll. */}
          <div className="list-card overflow-clip">
            {/* The two names again, over the two columns they belong to: by the
                time a row is being read the pickers are off the top of the list.
                A sticky element stops at the edge of its scroller's padding, so
                the -top-4 hands back the body's py-4 — without it the rows would
                slide by in the gap above the header. */}
            <div className={`${COLUMNS} sticky -top-4 z-10 bg-surface-2 px-3.5 py-1.5`}>
              <span />
              <span className="caption truncate">{comparison.left}</span>
              <span className="caption truncate">{comparison.right}</span>
            </div>

            {/* Not a direct child of the card, so the card's own hairlines do not
                reach between these. */}
            <ul className="divide-y divide-line">
              {comparison.rows.map((row) => (
                <Row key={row.name} row={row} />
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ row }: { row: Difference }) {
  return (
    <li className={['list-row', COLUMNS, row.same ? '' : 'bg-surface-2/50'].join(' ')}>
      <span
        data-hint={row.name}
        className={['truncate text-ui-base', row.same ? 'text-muted' : 'font-medium text-text'].join(
          ' ',
        )}
      >
        {row.name}
      </span>

      <Side standing={row.left} spec={row.leftSpec} />
      <Side standing={row.right} spec={row.rightSpec} />
    </li>
  )
}

/** How a standing reads, and how it is coloured. */
const STANDING: Record<Standing, { label: string; tone: BadgeTone }> = {
  active: { label: t('profile.standing.active'), tone: 'ok' },
  disabled: { label: t('profile.standing.disabled'), tone: 'neutral' },
  library: { label: t('profile.standing.library'), tone: 'neutral' },
  builtin: { label: t('profile.standing.builtin'), tone: 'neutral' },
  absent: { label: t('profile.standing.absent'), tone: 'neutral' },
}

function Side({ standing, spec }: { standing: Standing; spec: string }) {
  if (standing === 'absent') {
    return (
      <span
        data-hint={STANDING.absent.label}
        aria-label={STANDING.absent.label}
        className="text-ui-sm text-faint opacity-45"
      >
        —
      </span>
    )
  }

  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <Badge tone={STANDING[standing].tone}>{STANDING[standing].label}</Badge>
      {spec && (
        <span className="max-w-full truncate font-mono text-ui-xs text-faint tabular-nums">
          {spec}
        </span>
      )}
    </span>
  )
}

interface SidePickerProps {
  label: string
  value: string
  /** The other side's pick is not among them: comparing a profile to itself is not one. */
  options: string[]
  onPick: (name: string) => void
}

function SidePicker({ label, value, options, onPick }: SidePickerProps) {
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    useMenu.getState().show(
      box.left,
      box.bottom + 4,
      options.map((name) => ({
        label: name,
        selected: name === value,
        run: () => onPick(name),
      })),
    )
  }

  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label={label}
      onClick={open}
      className="select-trigger select-trigger--sm flex-1"
    >
      <span className="shrink-0 text-ui-xs text-faint">{label}</span>
      <span className="truncate text-text">{value}</span>
      <ChevronDown
        size={14}
        strokeWidth={2}
        className="ml-auto shrink-0 text-faint"
        aria-hidden="true"
      />
    </button>
  )
}

/* -------------------------------------------------------------------------- */

interface NameFormProps {
  form: Form
  busy: boolean
  onCancel: () => void
  onSubmit: (name: string) => void
}

/** What the button that finishes each form says, and what it looks like. */
const ACTION: Record<Form['kind'], { icon: LucideIcon; label: string }> = {
  create: { icon: Plus, label: t('profile.create') },
  duplicate: { icon: Copy, label: t('profile.create') },
  rename: { icon: Check, label: t('profile.save') },
  import: { icon: FileInput, label: t('profile.create') },
}

/**
 * A form's identity, used as its key.
 *
 * Opening one over another — Rename on a second row while the first is still up
 * — has to start the field on the second row's name, and the field's own state
 * is what says what is being typed.
 */
const identity = (form: Form): string =>
  form.kind === 'create'
    ? 'create'
    : form.kind === 'duplicate'
      ? `duplicate:${form.source}`
      : form.kind === 'rename'
        ? `rename:${form.from}`
        : `import:${form.path}`

/**
 * The one field all four of these need.
 *
 * New, copy, rename and import differ in what they do and not in what they ask,
 * so they share a form: a name, filled in with the obvious one, selected so that
 * typing replaces it and Enter accepts it. The rule it is checked against is the
 * shell's own — a name that npm would refuse is refused here, before a round
 * trip that could only come back saying the same thing.
 */
function NameForm({ form, busy, onCancel, onSubmit }: NameFormProps) {
  const suggestion =
    form.kind === 'duplicate'
      ? t('profile.copyName', { name: form.source })
      : form.kind === 'rename'
        ? form.from
        : form.kind === 'import'
          ? form.from
          : ''

  const [name, setName] = useState(suggestion)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])

  const heading =
    form.kind === 'create'
      ? t('profile.form.create')
      : form.kind === 'duplicate'
        ? t('profile.form.duplicate', { name: form.source })
        : form.kind === 'rename'
          ? t('profile.form.rename', { name: form.from })
          : t('profile.form.import', { name: form.from })

  const { icon: Icon, label } = ACTION[form.kind]
  const trimmed = name.trim()
  // Renaming something to what it is already called is not a rename.
  const ready =
    isNewProfileName(trimmed) && !(form.kind === 'rename' && trimmed === form.from) && !busy

  return (
    <section className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-canvas-deep/45 px-5 py-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="caption truncate">{heading}</h3>
        {form.kind === 'import' && (
          <div className="flex shrink-0 items-center gap-2 text-ui-sm text-faint tabular-nums">
            <Badge tone={form.verified ? 'ok' : 'warn'}>
              {form.verified ? t('profile.backupVerified') : t('profile.backupLegacy')}
            </Badge>
            <span>
              {form.plugins > 0
                ? t('profile.installedCount', { count: form.plugins })
                : t('profile.noPlugins')}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={field}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ready) {
              event.preventDefault()
              onSubmit(trimmed)
            }
          }}
          aria-label={t('profile.name')}
          placeholder={t('profile.namePlaceholder')}
          spellCheck={false}
          autoComplete="off"
          className="field-control selectable min-w-0 flex-1 font-mono placeholder:font-sans"
        />

        <Button variant="ghost" onClick={onCancel}>
          {t('dialog.cancel')}
        </Button>

        <Button variant="primary" onClick={() => onSubmit(trimmed)} disabled={!ready}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Icon aria-hidden="true" />}
          {label}
        </Button>
      </div>

      {form.kind === 'import' && (
        <p data-hint={form.path} className="selectable truncate font-mono text-ui-sm text-faint">
          {form.path}
        </p>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * A message about what just happened, in a box of its own.
 *
 * The tone is the colour of the whole message and not only of its mark: a
 * failure that has to be read — a path, a name the shell refused — is worth
 * reading in the colour that says it is one.
 */
function Notice({
  tone,
  icon: Icon,
  className,
  children,
}: {
  tone: 'ok' | 'danger'
  icon: LucideIcon
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={[
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-ui-sm',
        tone === 'ok' ? 'border-ok/30 bg-ok/10 text-ok' : 'border-danger/30 bg-danger/10 text-danger',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Icon size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
      <p className="selectable min-w-0 break-all">{children}</p>
    </div>
  )
}

/**
 * The shared empty state, centred in whatever room the tab has left.
 *
 * `Empty` fills its parent's height, and the tab's own height comes from its
 * content — so without a frame that has a height to give, it would sit at the
 * top of a region that is deliberately taller than it.
 */
function Blank(props: ComponentProps<typeof Empty>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center">
      <Empty {...props} />
    </div>
  )
}

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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

import { Button } from '@/components/Button'
import { TabButton } from '@/components/TabButton'
import { t } from '@/lib/i18n'
import type { Comparison, Difference, Profile, Standing } from '@/lib/ipc'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { ask } from '@/state/dialog'
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
      const path = await pickPath({
        title: t('profile.exportTitle'),
        defaultPath: `${name}.dsh-profile.json`,
        filters: [{ name: t('profile.fileKind'), extensions: ['json'] }],
      })
      if (path) await write(name, path)
    },
    [write],
  )

  const importProfile = useCallback(async () => {
    const path = await pickFile({
      title: t('profile.importTitle'),
      filters: [{ name: t('profile.fileKind'), extensions: ['json'] }],
    })
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
      className="fixed inset-0 z-30 grid animate-fade place-items-center bg-canvas-deep/70 p-8 backdrop-blur-[2px]"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={t('profile.title')}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-[620px] animate-pop flex-col overflow-hidden rounded-panel border border-line-strong bg-surface shadow-lift outline-none"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3.5">
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-[8px] border border-line bg-surface-2 text-brand"
          >
            <Layers size={17} strokeWidth={1.9} />
          </span>

          <div className="min-w-0 flex-1 pt-px">
            <h2 className="text-[13px] leading-snug font-semibold text-text">
              {t('profile.title')}
            </h2>
            {/* The root is the tooltip rather than the line, because a profile
                being a directory matters exactly once — when looking for it. */}
            <p className="mt-1 truncate text-[11px] text-faint" data-hint={roster?.root}>
              {t('profile.subtitle')}
            </p>
          </div>

          <button
            type="button"
            aria-label={t('profile.close')}
            data-hint={t('profile.close')}
            onClick={onClose}
            className="-mt-0.5 -mr-1 grid size-[26px] shrink-0 place-items-center rounded-control text-faint transition-colors duration-100 hover:bg-surface-2 hover:text-text"
          >
            <X size={14} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </header>

        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
          <div className="flex items-center gap-0.5 rounded-control bg-canvas-deep p-0.5 hairline">
            <TabButton
              label={t('profile.tab.list')}
              active={tab === 'list'}
              onClick={() => setTab('list')}
            />
            <TabButton
              label={t('profile.tab.compare')}
              active={tab === 'compare'}
              onClick={() => setTab('compare')}
            />
          </div>

          {tab === 'list' ? (
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="secondary"
                onClick={() => void importProfile()}
                disabled={working !== null}
              >
                <FileInput size={13} strokeWidth={2.2} aria-hidden="true" />
                {t('profile.importFile')}
              </Button>
              <Button
                variant="primary"
                onClick={() => setForm({ kind: 'create' })}
                disabled={working !== null}
              >
                <Plus size={14} strokeWidth={2.4} aria-hidden="true" />
                {t('profile.new')}
              </Button>
            </div>
          ) : (
            <span className="ml-auto shrink-0 text-[11.5px] text-faint tabular-nums">
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

        {error ? (
          <Notice tone="danger" icon={TriangleAlert}>
            {error}
          </Notice>
        ) : (
          note && (
            <Notice tone="ok" icon={Check}>
              {note}
            </Notice>
          )
        )}

        {/* One height for both tabs: switching between them should move the
            content, not the window. */}
        <div className="flex min-h-[232px] flex-col overflow-hidden">
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

        <footer className="flex shrink-0 items-center gap-2.5 border-t border-line bg-canvas-deep/40 px-4 py-3">
          {working !== null ? (
            <>
              <Loader2 size={12} className="shrink-0 animate-spin text-brand" aria-hidden="true" />
              <p className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-faint">
                {latest || working}
              </p>
            </>
          ) : (
            <>
              <Info size={12} strokeWidth={2} className="shrink-0 text-faint" aria-hidden="true" />
              <p className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
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
    return <Empty icon={Boxes} message={t('profile.empty')} hint={t('profile.emptyHint')} />
  }

  return (
    <ul className="min-h-0 flex-1 overflow-y-auto">
      {profiles.map((profile) => {
        const hosted = profile.name === selected
        const busy = working === profile.name
        const menu = () => actions(profile)

        return (
          <li
            key={profile.name}
            onContextMenu={contextMenu(menu)}
            className="relative flex items-center gap-3 border-b border-line px-4 py-2.5"
          >
            {hosted && (
              <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-brand" />
            )}

            <span
              aria-hidden="true"
              className={[
                'grid size-8 shrink-0 place-items-center rounded-[7px] border border-line',
                hosted ? 'bg-surface-2 text-brand' : 'bg-surface-2/50 text-faint',
              ].join(' ')}
            >
              <Boxes size={15} strokeWidth={1.9} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span
                  data-hint={profile.dir}
                  className="truncate text-[12.5px] font-medium text-text"
                >
                  {profile.name}
                </span>
                {profile.shipped && <Badge>{t('profile.builtinTag')}</Badge>}
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-faint">
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
              <span className="inline-flex h-[22px] shrink-0 items-center gap-1 px-1 text-[11.5px] font-medium text-ok">
                <Check size={11} strokeWidth={2.6} aria-hidden="true" />
                {t('profile.inUse')}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onUse(profile.name)}
                disabled={working !== null}
                className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[4px] border border-line-strong bg-surface-2 px-2 text-[11.5px] font-medium text-text transition duration-100 enabled:hover:brightness-[1.2] enabled:active:brightness-95 disabled:opacity-45"
              >
                {busy && <Loader2 size={11} className="animate-spin" aria-hidden="true" />}
                {t('profile.use')}
              </button>
            )}

            <button
              type="button"
              aria-haspopup="menu"
              aria-label={t('profile.actions')}
              data-hint={t('profile.actions')}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect()
                useMenu.getState().show(box.left, box.bottom + 4, menu())
              }}
              className="grid size-[26px] shrink-0 place-items-center rounded-control border border-line-strong bg-surface-2 text-muted transition duration-100 enabled:hover:text-text enabled:hover:brightness-[1.15] enabled:active:brightness-95 disabled:opacity-45"
            >
              <MoreHorizontal size={13} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
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
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_92px_92px] items-center gap-2'

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
    return <Empty icon={ArrowLeftRight} message={t('profile.needTwo')} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <SidePicker
          label={t('profile.left')}
          value={left}
          options={names.filter((name) => name !== right)}
          onPick={(name) => onPick('left', name)}
        />
        <ArrowLeftRight
          size={13}
          strokeWidth={2.1}
          className="shrink-0 text-faint"
          aria-hidden="true"
        />
        <SidePicker
          label={t('profile.right')}
          value={right}
          options={names.filter((name) => name !== left)}
          onPick={(name) => onPick('right', name)}
        />
      </div>

      {comparison === null ? (
        <Empty icon={Loader2} message={t('profile.comparing')} spin={comparing} />
      ) : comparison.rows.length === 0 ? (
        <Empty icon={Boxes} message={t('profile.identical')} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {comparison.differences === 0 && (
            <p className="border-b border-line bg-ok/8 px-4 py-2 text-[11.5px] text-muted">
              {t('profile.identical')}
            </p>
          )}

          {/* The two names again, over the two columns they belong to: by the
              time a row is being read the pickers are off the top of the list. */}
          <div className={`${COLUMNS} sticky top-0 border-b border-line bg-surface px-4 py-1.5`}>
            <span />
            <span className="caption truncate">{comparison.left}</span>
            <span className="caption truncate">{comparison.right}</span>
          </div>

          <ul>
            {comparison.rows.map((row) => (
              <Row key={row.name} row={row} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Row({ row }: { row: Difference }) {
  return (
    <li
      className={[
        COLUMNS,
        'relative border-b border-line px-4 py-2',
        row.same ? '' : 'bg-surface-2/40',
      ].join(' ')}
    >
      {!row.same && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-brand" />
      )}

      <span
        data-hint={row.name}
        className={['truncate text-[12px]', row.same ? 'text-muted' : 'font-medium text-text'].join(
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
const STANDING: Record<Standing, { label: string; tone: string }> = {
  active: { label: t('profile.standing.active'), tone: 'bg-ok/15 text-ok' },
  disabled: { label: t('profile.standing.disabled'), tone: 'bg-surface-2 text-faint' },
  library: { label: t('profile.standing.library'), tone: 'bg-surface-2 text-muted' },
  builtin: { label: t('profile.standing.builtin'), tone: 'bg-surface-2 text-faint' },
  absent: { label: t('profile.standing.absent'), tone: '' },
}

function Side({ standing, spec }: { standing: Standing; spec: string }) {
  if (standing === 'absent') {
    return (
      <span
        data-hint={STANDING.absent.label}
        aria-label={STANDING.absent.label}
        className="text-[12px] text-faint opacity-45"
      >
        —
      </span>
    )
  }

  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <span
        className={[
          'rounded-[4px] px-1.5 py-0.5 text-[10.5px] font-medium',
          STANDING[standing].tone,
        ].join(' ')}
      >
        {STANDING[standing].label}
      </span>
      {spec && (
        <span className="max-w-full truncate font-mono text-[10px] text-faint tabular-nums">
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
        icon: name === value ? Check : undefined,
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
      className="flex h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-control border border-line-strong bg-surface-2 px-2 text-[12px] transition duration-100 hover:brightness-[1.15] active:brightness-95"
    >
      <span className="shrink-0 text-[11px] text-faint">{label}</span>
      <span className="truncate font-medium text-text">{value}</span>
      <ChevronDown
        size={11}
        strokeWidth={2.4}
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
    <section className="flex shrink-0 flex-col gap-2 border-b border-line bg-canvas-deep/45 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="caption truncate">{heading}</h3>
        {form.kind === 'import' && (
          <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
            <span className={form.verified ? 'text-ok' : 'text-warn'}>
              {form.verified ? t('profile.backupVerified') : t('profile.backupLegacy')}
            </span>
            <span className="text-faint">
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
          className="selectable h-[30px] min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-2.5 font-mono text-[12px] text-text outline-none placeholder:font-sans placeholder:text-faint focus-visible:border-brand/60"
        />

        <Button variant="ghost" onClick={onCancel}>
          {t('dialog.cancel')}
        </Button>

        <Button variant="primary" onClick={() => onSubmit(trimmed)} disabled={!ready}>
          {busy ? (
            <Loader2 size={13} className="animate-spin" aria-hidden="true" />
          ) : (
            <Icon size={13} strokeWidth={2.3} aria-hidden="true" />
          )}
          {label}
        </Button>
      </div>

      {form.kind === 'import' && (
        <p data-hint={form.path} className="selectable truncate font-mono text-[10.5px] text-faint">
          {form.path}
        </p>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-[4px] bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-faint">
      {children}
    </span>
  )
}

function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'ok' | 'danger'
  icon: LucideIcon
  children: ReactNode
}) {
  return (
    <div
      className={[
        'flex shrink-0 items-start gap-2 border-b px-4 py-2',
        tone === 'ok' ? 'border-line bg-ok/10' : 'border-danger/25 bg-danger/10',
      ].join(' ')}
    >
      <Icon
        size={13}
        strokeWidth={2.1}
        className={`mt-[2px] shrink-0 ${tone === 'ok' ? 'text-ok' : 'text-danger'}`}
        aria-hidden="true"
      />
      <p className="selectable text-[11.5px] leading-relaxed break-all text-muted">{children}</p>
    </div>
  )
}

function Empty({
  icon: Icon,
  message,
  hint,
  spin = false,
}: {
  icon: LucideIcon
  message: string
  hint?: string
  spin?: boolean
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Icon
        size={22}
        strokeWidth={1.4}
        className={`text-faint opacity-60 ${spin ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      <p className="text-[12px] text-faint">{message}</p>
      {hint && <p className="max-w-[320px] text-[11px] text-faint opacity-75">{hint}</p>}
    </div>
  )
}

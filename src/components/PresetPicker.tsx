/**
 * Which agent a new session starts as.
 *
 * A radio group and not a dropdown. There are four of these, they differ in ways
 * that take a sentence to explain, and the choice is made about twice in the
 * lifetime of an install — that is a set of things to read and compare, not a
 * value to pick from a list you have to open first.
 *
 * Two sizes of the same control. The guide has a pane to itself and shows each
 * one's description; the console rail is one column of two and shows the names,
 * with the description on the pointer. Neither is a different component, because
 * they are the same choice and would otherwise be two things to keep in agreement.
 *
 * Drawn as a list card of rows, the same surface as the environment checks it
 * sits beside in the console, so the two columns share their row lines. A column
 * of separately bordered cards next to a single bordered list reads as two designs
 * that happen to be on one screen.
 *
 * The names are the harness's own words in whatever language it shipped them in.
 * Nothing here translates them: a preset the user wrote themselves is shown the
 * same way, and putting invented text on somebody else's preset would be worse
 * than showing theirs.
 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { Archive, Download, Loader2, Upload } from 'lucide-react'
import { open as pickFile, save as pickPath } from '@tauri-apps/plugin-dialog'

import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { t } from '@/lib/i18n'
import type { AgentPreset } from '@/lib/ipc'
import * as ipc from '@/lib/ipc'
import { describe } from '@/lib/errors'
import { importPresetPackage, usePresets } from '@/state/presets'

export function PresetPicker({ detail = false }: { detail?: boolean }) {
  const presets = usePresets((state) => state.presets)
  const chosen = usePresets((state) => state.chosen)
  const loading = usePresets((state) => state.loading)
  const error = usePresets((state) => state.error)
  const refresh = usePresets((state) => state.refresh)
  const choose = usePresets((state) => state.choose)
  const chosenPreset = presets.find((preset) => preset.id === chosen)
  const [transferError, setTransferError] = useState<string | null>(null)
  const [transferring, setTransferring] = useState<'export' | 'import' | null>(null)

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLButtonElement) || event.target.role !== 'radio') return

    const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')]
    const current = choices.indexOf(event.target)
    if (current < 0 || choices.length === 0) return

    let next = current
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
      next = (current + 1) % choices.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      next = (current - 1 + choices.length) % choices.length
    } else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = choices.length - 1
    else return

    event.preventDefault()
    choices[next]?.focus()
    choices[next]?.click()
  }

  const exportPreset = async () => {
    if (!chosen || transferring !== null) return
    setTransferring('export')
    setTransferError(null)
    try {
      const path = await pickPath({
        title: t('preset.exportTitle'),
        defaultPath: `${chosen}.dshpreset`,
        filters: [{ name: 'DSH preset', extensions: ['dshpreset'] }],
      })
      if (path) await ipc.presetExport(chosen, path)
    } catch (cause) {
      setTransferError(describe(cause))
    } finally {
      setTransferring(null)
    }
  }

  const importPreset = async () => {
    if (transferring !== null) return
    setTransferring('import')
    setTransferError(null)
    try {
      const path = await pickFile({
        title: t('preset.importTitle'),
        multiple: false,
        filters: [{ name: 'DSH preset', extensions: ['dshpreset'] }],
      })
      if (!path || Array.isArray(path)) return
      await importPresetPackage(path)
    } catch (cause) {
      setTransferError(describe(cause))
    } finally {
      setTransferring(null)
    }
  }

  // Re-read on mount rather than once for the app's lifetime: the harness ships
  // these inside its own install, so the list is empty until it is installed and
  // this is the component that will be looked at straight afterwards.
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loading && presets.length === 0) {
    return (
      <p className="flex items-center gap-2 text-ui-base text-muted">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        {t('status.starting')}
      </p>
    )
  }

  if (presets.length === 0) {
    return <p className="text-ui-sm text-faint">{t('guide.agent.empty')}</p>
  }

  return (
    <div className="flex flex-col gap-3">
      {detail && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!chosen || chosenPreset?.shipped !== false || transferring !== null}
            onClick={() => void exportPreset()}
          >
            {transferring === 'export' ? <Loader2 className="animate-spin" /> : <Download />}
            {t('preset.export')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={transferring !== null}
            onClick={() => void importPreset()}
          >
            {transferring === 'import' ? <Loader2 className="animate-spin" /> : <Upload />}
            {t('preset.import')}
          </Button>
          <span className="inline-flex items-center gap-1.5 text-ui-sm text-faint">
            <Archive size={14} aria-hidden="true" />
            {t('preset.transferHint')}
          </span>
        </div>
      )}
      <div
        role="radiogroup"
        aria-label={t('section.agent')}
        onKeyDown={moveSelection}
        className="list-card"
      >
        {presets.map((preset) => (
          <Choice
            key={preset.id}
            preset={preset}
            chosen={preset.id === chosen}
            tabbable={preset.id === (chosen ?? presets[0]?.id)}
            detail={detail}
            onChoose={() => void choose(preset.id)}
          />
        ))}
      </div>

      {error && (
        <p className="selectable rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      {transferError && (
        <p className="selectable rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger [overflow-wrap:anywhere]">
          {transferError}
        </p>
      )}
    </div>
  )
}

/**
 * One preset, as something to press.
 *
 * A button carrying radio semantics rather than an `<input>`: the whole row is
 * the target, and a dot inside a row that wide is not a target. `aria-checked`
 * and the group above it are what keep it a radio to everything that is not
 * looking at the pixels.
 *
 * The row is the list card's own and not a card of its own, so two things about
 * it differ from a free-standing control. The focus ring is drawn inside the edge,
 * because the card clips what leaves it and a ring at the usual offset would be
 * cut off on three sides; and the corner is squared, because the global focus rule
 * gives a focused element a 4px one, which would round the selected fill against
 * the rows above and below it. Only the fill is transitioned, because
 * `transition-colors` carries the outline's colour with it and the ring would
 * fade in from grey.
 */
function Choice({
  preset,
  chosen,
  tabbable,
  detail,
  onChoose,
}: {
  preset: AgentPreset
  chosen: boolean
  tabbable: boolean
  detail: boolean
  onChoose: () => void
}) {
  // The id is the fallback and not a second line: a preset with no readable
  // metadata still has to be pickable, and its directory name is what the person
  // who made it called it.
  const name = preset.name ?? preset.id

  // Only where the description is on the row. A row without one stays single-line
  // rather than being padded out to the height of its neighbours.
  const described = detail && Boolean(preset.description)

  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      tabIndex={tabbable ? 0 : -1}
      onClick={onChoose}
      // Only where the description is not already on the row. Two ways of
      // reading the same sentence is one more than anybody needs.
      data-hint={detail ? undefined : (preset.description ?? undefined)}
      className={[
        'list-row group w-full rounded-none text-left transition-[background-color] focus-visible:-outline-offset-2',
        // The dot and the badge sit on the name's line, not in the middle of the block.
        described && 'list-row--roomy items-start',
        chosen ? 'bg-surface-2' : 'hover:bg-surface-2/70',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Dot chosen={chosen} className={described ? 'mt-0.5' : undefined} />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-ui-base text-text">{name}</span>
        {described && (
          // Under the name rather than under the dot, so the row reads as one
          // block rather than two.
          <span className="text-ui-sm text-faint">{preset.description}</span>
        )}
      </span>

      {chosen && <Badge tone="ok">{t('preset.current')}</Badge>}
      {!chosen && !preset.shipped && <Badge>{t('preset.yours')}</Badge>}
    </button>
  )
}

/** The selected state, drawn rather than borrowed from the platform. */
function Dot({ chosen, className }: { chosen: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'grid size-4 shrink-0 place-items-center rounded-full transition duration-150',
        chosen
          ? 'bg-brand shadow-[inset_0_0_0_1px_var(--color-brand)]'
          : 'shadow-[inset_0_0_0_1px_var(--color-control-border)] group-hover:shadow-[inset_0_0_0_1px_var(--color-control-border-hover)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {chosen && <span className="size-1.5 rounded-full bg-on-brand" />}
    </span>
  )
}

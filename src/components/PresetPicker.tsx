/**
 * Which agent a new session starts as.
 *
 * A radio group and not a dropdown. There are four of these, they differ in ways
 * that take a sentence to explain, and the choice is made about twice in the
 * lifetime of an install — that is a set of things to read and compare, not a
 * value to pick from a list you have to open first.
 *
 * Two sizes of the same control. The guide has a pane to itself and shows each
 * one's description; the console rail has 340px and shows the names, with the
 * description on the pointer. Neither is a different component, because they are
 * the same choice and would otherwise be two things to keep in agreement.
 *
 * The names are the harness's own words in whatever language it shipped them in.
 * Nothing here translates them: a preset the user wrote themselves is shown the
 * same way, and putting invented text on somebody else's preset would be worse
 * than showing theirs.
 */
import { useEffect } from 'react'
import { Loader2 } from 'lucide-react'

import { t } from '@/lib/i18n'
import type { AgentPreset } from '@/lib/ipc'
import { usePresets } from '@/state/presets'

export function PresetPicker({ detail = false }: { detail?: boolean }) {
  const presets = usePresets((state) => state.presets)
  const chosen = usePresets((state) => state.chosen)
  const loading = usePresets((state) => state.loading)
  const error = usePresets((state) => state.error)
  const refresh = usePresets((state) => state.refresh)
  const choose = usePresets((state) => state.choose)

  // Re-read on mount rather than once for the app's lifetime: the harness ships
  // these inside its own install, so the list is empty until it is installed and
  // this is the component that will be looked at straight afterwards.
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loading && presets.length === 0) {
    return (
      <p className="flex items-center gap-2 px-0.5 py-1 text-[12px] text-faint">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        {t('status.starting')}
      </p>
    )
  }

  if (presets.length === 0) {
    return <p className="px-0.5 text-[12px] leading-relaxed text-faint">{t('guide.agent.empty')}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label={t('section.agent')} className="flex flex-col gap-1.5">
        {presets.map((preset) => (
          <Choice
            key={preset.id}
            preset={preset}
            chosen={preset.id === chosen}
            detail={detail}
            onChoose={() => void choose(preset.id)}
          />
        ))}
      </div>

      {error && (
        <p className="selectable rounded-control border border-danger/30 bg-danger/10 px-2.5 py-2 text-[12px] leading-relaxed text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * One preset, as something to press.
 *
 * A button carrying radio semantics rather than an `<input>`: the whole card is
 * the target, and a 6px dot inside a 300px row is not a target. `aria-checked`
 * and the group above it are what keep it a radio to everything that is not
 * looking at the pixels.
 */
function Choice({
  preset,
  chosen,
  detail,
  onChoose,
}: {
  preset: AgentPreset
  chosen: boolean
  detail: boolean
  onChoose: () => void
}) {
  // The id is the fallback and not a second line: a preset with no readable
  // metadata still has to be pickable, and its directory name is what the person
  // who made it called it.
  const name = preset.name ?? preset.id

  return (
    <button
      type="button"
      role="radio"
      aria-checked={chosen}
      onClick={onChoose}
      // Only where the description is not already on the card. Two ways of
      // reading the same sentence is one more than anybody needs.
      data-hint={detail ? undefined : (preset.description ?? undefined)}
      className={[
        'group flex w-full cursor-pointer flex-col gap-1 rounded-control border px-2.5 text-left transition duration-100 ease-[var(--ease-out-soft)]',
        detail ? 'py-2.5' : 'py-2',
        chosen
          ? 'border-brand/55 bg-brand/8'
          : 'border-line bg-canvas-deep/40 hover:border-line-strong hover:bg-surface-2',
      ].join(' ')}
    >
      <span className="flex items-center gap-2">
        <Dot chosen={chosen} />
        <span
          className={`min-w-0 truncate text-[12.5px] font-medium ${chosen ? 'text-text' : 'text-muted group-hover:text-text'}`}
        >
          {name}
        </span>

        {chosen && (
          <span className="ml-auto shrink-0 rounded-[4px] bg-brand/15 px-1.5 py-0.5 text-[10.5px] font-medium text-brand">
            {t('preset.current')}
          </span>
        )}
        {!chosen && !preset.shipped && (
          <span className="ml-auto shrink-0 text-[10.5px] text-faint">{t('preset.yours')}</span>
        )}
      </span>

      {detail && preset.description && (
        // Indented past the dot so the description lines up under the name and
        // the row reads as one block rather than two.
        <span className="pl-[22px] text-[11.5px] leading-relaxed text-faint">
          {preset.description}
        </span>
      )}
    </button>
  )
}

/** The selected state, drawn rather than borrowed from the platform. */
function Dot({ chosen }: { chosen: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'grid size-[14px] shrink-0 place-items-center rounded-full border transition duration-100',
        chosen ? 'border-brand' : 'border-line-strong group-hover:border-muted',
      ].join(' ')}
    >
      {chosen && <span className="size-[6px] rounded-full bg-brand" />}
    </span>
  )
}

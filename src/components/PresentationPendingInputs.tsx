import { useId } from 'react'
import { Button } from '@/components/Button'
import { usePresentationEditor } from '@/state/presentation-editor'
import { t } from '@/lib/i18n'

/**
 * Pending field values outlive the pane, including a React boundary unmount.
 *
 * Still a `<fieldset>` because `disabled` on it is what locks every field and
 * button inside while the editor is busy, and a heading names it in place of the
 * `<legend>` whose border would otherwise be drawn through the card's edge.
 */
export function PresentationPendingInputs() {
  const heading = useId()
  const inputs = usePresentationEditor((state) => state.inputs)
  const busy = usePresentationEditor((state) => state.busy)
  if (!Object.keys(inputs).length) return null
  return (
    <fieldset
      aria-labelledby={heading}
      disabled={busy !== null && busy !== 'save'}
      className="card mt-3 flex max-h-64 min-w-0 flex-col gap-3 overflow-y-auto p-4"
    >
      <h3 id={heading} className="caption">
        {t('deck.pendingInputs')}
      </h3>
      {Object.entries(inputs).map(([key, input]) => (
        <div key={key} className="flex flex-col gap-2">
          <label className="block">
            <span className="field-label">{input.label}</span>
            <textarea
              className="field-control w-full"
              value={input.value}
              rows={2}
              onChange={(event) =>
                usePresentationEditor
                  .getState()
                  .stageInput(key, { ...input, value: event.target.value })
              }
            />
          </label>
          <Button
            variant="danger-ghost"
            size="sm"
            className="-ml-2.5 self-start"
            onClick={() => usePresentationEditor.getState().discardInput(key)}
          >
            {t('deck.discardInput')}
          </Button>
        </div>
      ))}
    </fieldset>
  )
}

import { usePresentationEditor } from '@/state/presentation-editor'
import { t } from '@/lib/i18n'

/** Pending field values outlive the pane, including a React boundary unmount. */
export function PresentationPendingInputs() {
  const inputs = usePresentationEditor((state) => state.inputs)
  const busy = usePresentationEditor((state) => state.busy)
  if (!Object.keys(inputs).length) return null
  return (
    <fieldset
      disabled={busy !== null && busy !== 'save'}
      className="mt-3 max-h-64 space-y-3 overflow-y-auto rounded-control border border-line p-3"
    >
      <legend className="px-1 text-xs text-muted">{t('deck.pendingInputs')}</legend>
      {Object.entries(inputs).map(([key, input]) => (
        <div key={key} className="space-y-1">
          <label className="block space-y-1 text-xs">
            <span>{input.label}</span>
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
          <button
            type="button"
            className="text-xs text-muted underline"
            onClick={() => usePresentationEditor.getState().discardInput(key)}
          >
            {t('deck.discardInput')}
          </button>
        </div>
      ))}
    </fieldset>
  )
}

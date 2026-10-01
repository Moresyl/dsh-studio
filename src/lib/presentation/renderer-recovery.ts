import { isPresentationDirty, usePresentationEditor } from '@/state/presentation-editor'
import { t } from '@/lib/i18n'
import { useLibrary } from '@/state/library'

export function canAutomaticallyReload(): boolean {
  const state = usePresentationEditor.getState()
  const personal = useLibrary.getState()
  return (
    !personal.editing &&
    !personal.busy &&
    !isPresentationDirty(state) &&
    (state.busy === null || (state.busy === 'synchronizing' && state.document === null))
  )
}

/** A failed save or an edit during saving must never fall through to reload. */
export async function reloadPreservingPresentation(
  reload: () => void | Promise<void>,
  saveDirty = true,
): Promise<boolean> {
  const personal = useLibrary.getState()
  if (personal.editing || personal.busy) {
    if (!saveDirty) return false
    throw new Error(t('organize.saveBeforeExit'))
  }
  if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement)
    document.activeElement.blur()
  let state = usePresentationEditor.getState()
  if (state.busy === 'synchronizing' && state.document === null) {
    await reload()
    return true
  }
  if (state.busy !== null) {
    if (!saveDirty) return false
    throw new Error(t('deck.busy'))
  }
  if (isPresentationDirty(state)) {
    if (!saveDirty) return false
    if (!(await state.save()))
      throw new Error(usePresentationEditor.getState().error ?? t('deck.recoverySaveFailed'))
  }
  state = usePresentationEditor.getState()
  if (!state.lockForUpdate()) {
    if (!saveDirty) return false
    throw new Error(t('deck.recoveryChanged'))
  }
  try {
    await reload()
    return true
  } catch (cause) {
    state.unlockUpdate()
    throw cause
  }
}

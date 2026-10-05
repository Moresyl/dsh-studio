import { ask } from '@/state/dialog'
import { useHarness } from '@/state/harness'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { reportFailure } from '@/state/failure'
import { useProjectNotes } from '@/state/project-notes'

/** Select a native directory and offer the restart needed to apply it. */
export async function switchWorkspace(path: string): Promise<boolean> {
  const notes = useProjectNotes.getState()
  if (!(await notes.save()) || !useProjectNotes.getState().lock()) {
    reportFailure(new Error(t('notes.saveBeforeExit')))
    return false
  }
  try {
    await ipc.workspaceSelect(path)
    await useHarness.getState().inspect()
  } catch (cause) {
    useHarness.setState({ error: reportFailure(cause) })
    return false
  } finally {
    useProjectNotes.getState().unlock()
  }
  // The panel may have observed the selected path while the editor was locked.
  await useProjectNotes.getState().load()

  const { phase } = useHarness.getState().status
  if (phase === 'stopped' || phase === 'failed') return true
  const restart = await ask({
    title: t('workspace.restartTitle'),
    body: t('workspace.restartBody'),
    subject: path,
    confirm: t('workspace.restartConfirm'),
    tone: 'brand',
  })
  if (!restart) return true
  await useHarness.getState().stop()
  await useHarness.getState().start()
  return true
}

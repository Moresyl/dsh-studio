import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  applicationLifecycleReply,
  applicationLifecycleState,
  onLifecyclePrepare,
  onLifecycleRelease,
  onLifecycleBlocked,
} from '@/lib/ipc'
import { isPresentationDirty, usePresentationEditor } from '@/state/presentation-editor'
import { reportFailure } from '@/state/failure'
import { t } from '@/lib/i18n'
import { useLibrary } from '@/state/library'
import { notesDirty, useProjectNotes } from '@/state/project-notes'

/** Hold a stable local document snapshot until the native all-window lease ends. */
export async function guardApplicationLifecycle(): Promise<() => void> {
  const stops: (() => void)[] = []
  let request: string | null = null
  let owned = false
  let ownedNotes = false
  let syncing = true
  const released = new Set<string>()
  const synchronized = () => {
    if (usePresentationEditor.getState().busy === 'synchronizing')
      usePresentationEditor.setState({ busy: null })
  }
  const release = (id: string) => {
    if (syncing) released.add(id)
    if (request !== id) return
    request = null
    if (owned) usePresentationEditor.getState().unlockUpdate()
    owned = false
    if (ownedNotes) useProjectNotes.getState().unlock()
    ownedNotes = false
  }
  const prepare = (id: string, awaiting = true) => {
    if (request !== null) return
    request = id
    synchronized()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const state = usePresentationEditor.getState()
    // The initiating window may already own the local updater lock.
    const inherited = state.busy === 'update' && !isPresentationDirty(state)
    const personal = useLibrary.getState()
    const personalReady = !personal.busy && !personal.editing
    const notes = useProjectNotes.getState()
    const inheritedNotes = inherited && notes.locked && !notes.busy && !notesDirty(notes)
    ownedNotes = personalReady && !inheritedNotes && notes.lock()
    const notesReady = inheritedNotes || ownedNotes
    owned = notesReady && !inherited && state.lockForUpdate()
    const ready = personalReady && notesReady && (inherited || owned)
    if (!ready) {
      if (ownedNotes) useProjectNotes.getState().unlock()
      ownedNotes = false
      void getCurrentWindow().show().catch(reportFailure)
      reportFailure(
        new Error(
          t(
            !personalReady
              ? 'organize.saveBeforeExit'
              : !notesReady
                ? 'notes.saveBeforeExit'
                : 'deck.saveBeforeExit',
          ),
        ),
      )
    }
    // A reloaded document rejoins an already-approved lease without a second vote.
    if (awaiting)
      void applicationLifecycleReply(id, ready).catch((cause) => {
        release(id)
        reportFailure(cause)
      })
  }
  try {
    // Subscribe to release before prepare so a cancelled request cannot leave a lock behind.
    stops.push(await onLifecycleRelease(release))
    stops.push(await onLifecycleBlocked(() => reportFailure(new Error(t('deck.saveBeforeExit')))))
    stops.push(await onLifecyclePrepare(prepare))
    const pending = await applicationLifecycleState()
    // Ignore a released snapshot, but not a different live lease just because an
    // older request's release arrived while the snapshot was in flight.
    if (request === null && pending && !released.has(pending.id))
      prepare(pending.id, pending.awaiting)
    syncing = false
    released.clear()
    synchronized()
  } catch (cause) {
    stops.forEach((stop) => stop())
    throw cause
  }
  return () => {
    stops.forEach((stop) => stop())
    if (request !== null) release(request)
  }
}

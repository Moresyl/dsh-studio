import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  applicationLifecycleReply,
  onLifecyclePrepare,
  onLifecycleRelease,
  onLifecycleBlocked,
} from '@/lib/ipc'
import { isPresentationDirty, usePresentationEditor } from '@/state/presentation-editor'
import { reportFailure } from '@/state/failure'
import { t } from '@/lib/i18n'

/** Hold a stable local document snapshot until the native all-window lease ends. */
export async function guardApplicationLifecycle(): Promise<() => void> {
  const stops: (() => void)[] = []
  let request: string | null = null
  let owned = false
  const release = (id: string) => {
    if (request !== id) return
    request = null
    if (owned) usePresentationEditor.getState().unlockUpdate()
    owned = false
  }
  try {
    // Subscribe to release before prepare so a cancelled request cannot leave a lock behind.
    stops.push(await onLifecycleRelease(release))
    stops.push(await onLifecycleBlocked(() => reportFailure(new Error(t('deck.saveBeforeExit')))))
    stops.push(
      await onLifecyclePrepare((id) => {
        if (request !== null) return
        request = id
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        const state = usePresentationEditor.getState()
        // The initiating window may already own the local updater lock.
        const inherited = state.busy === 'update' && !isPresentationDirty(state)
        owned = !inherited && state.lockForUpdate()
        const ready = inherited || owned
        if (!ready) {
          void getCurrentWindow().show().catch(reportFailure)
          reportFailure(new Error(t('deck.saveBeforeExit')))
        }
        void applicationLifecycleReply(id, ready).catch((cause) => {
          release(id)
          reportFailure(cause)
        })
      }),
    )
  } catch (cause) {
    stops.forEach((stop) => stop())
    throw cause
  }
  return () => {
    stops.forEach((stop) => stop())
    if (request !== null) release(request)
  }
}

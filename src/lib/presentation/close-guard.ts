import { getCurrentWindow } from '@tauri-apps/api/window'
import { isPresentationDirty, usePresentationEditor } from '@/state/presentation-editor'
import { ask } from '@/state/dialog'
import { reportFailure } from '@/state/failure'
import { t } from '@/lib/i18n'
import { status } from '@/lib/ipc'
import { useLibrary } from '@/state/library'
import { notesDirty, useProjectNotes } from '@/state/project-notes'

/** Keep native window close from silently discarding the current editor draft. */
export async function guardPresentationClose(): Promise<() => void> {
  const window = getCurrentWindow()
  let accepted = false
  let asking = false
  let disposed = false
  const stop = await window.onCloseRequested(async (event) => {
    // Tauri's listener destroys a window when its handler does not prevent
    // closure. The main window's tray action must retain its WebView and draft.
    if (window.label === 'main') {
      try {
        const current = await status()
        if (current.phase !== 'stopped' && current.phase !== 'failed') {
          accepted = false
          event.preventDefault()
          await window.hide()
          return
        }
      } catch (cause) {
        accepted = false
        event.preventDefault()
        await window.show().catch(() => {})
        reportFailure(cause)
        return
      }
    }
    if (accepted) {
      accepted = false
      return
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const personal = useLibrary.getState()
    if (personal.busy || personal.editing) {
      event.preventDefault()
      await window.show().catch(reportFailure)
      reportFailure(new Error(t('organize.saveBeforeExit')))
      return
    }
    const state = usePresentationEditor.getState()
    const notes = useProjectNotes.getState()
    if (notes.busy || notes.locked || notesDirty(notes)) {
      event.preventDefault()
      await window.show().catch(reportFailure)
      reportFailure(new Error(t('notes.saveBeforeExit')))
      return
    }
    if (!isPresentationDirty(state) && !state.busy) return
    event.preventDefault()
    if (asking) return
    asking = true
    try {
      // The main window's tray handler may have hidden it on this same event.
      await window.show()
      if (state.busy) {
        reportFailure(new Error(t('deck.busy')))
        return
      }
      const discard = await ask({
        title: t('deck.discardTitle'),
        body: t('deck.closeBody'),
        confirm: t('deck.discard'),
        tone: 'danger',
      })
      if (discard && !disposed) {
        accepted = true
        await window.close()
      }
    } catch (cause) {
      accepted = false
      reportFailure(cause)
    } finally {
      asking = false
    }
  })
  return () => {
    disposed = true
    stop()
  }
}

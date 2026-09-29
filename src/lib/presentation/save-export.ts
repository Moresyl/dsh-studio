import { save } from '@tauri-apps/plugin-dialog'
import { presentationExportSave } from '@/lib/ipc'
import { t } from '@/lib/i18n'
import { attachmentFilename } from '@/lib/attachment-save'
import { parsePresentation } from './document'
import { exportPresentationBackground } from './export-background'

export type ExportPhase = 'choosing' | 'generating' | 'saving'

/** Export the snapshot reviewed at click time; dismissing the dialog writes nothing. */
export async function savePresentationExport(
  source: unknown,
  signal: AbortSignal,
  progress: (phase: ExportPhase) => void,
): Promise<boolean> {
  signal.throwIfAborted()
  const document = parsePresentation(source)
  progress('choosing')
  const path = await save({
    title: t('deck.export'),
    defaultPath: `${attachmentFilename(document.title.replace(/\.pptx$/i, ''))}.pptx`,
    filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
  })
  if (!path || signal.aborted) return false
  if (!/\.pptx$/i.test(path)) throw new Error(t('deck.exportExtension'))
  progress('generating')
  const bytes = await exportPresentationBackground(document, signal)
  signal.throwIfAborted()
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  }
  const data = btoa(chunks.join(''))
  signal.throwIfAborted()
  // Native atomic replacement cannot be cancelled after it starts.
  progress('saving')
  await presentationExportSave(path, data)
  return true
}

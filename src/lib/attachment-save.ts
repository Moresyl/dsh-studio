import { save } from '@tauri-apps/plugin-dialog'
import { downloadFile, previewImage } from '@/lib/attachment-preview'
import { sessionAttachmentSave, type SessionAttachment } from '@/lib/ipc'
import { t } from '@/lib/i18n'

export function attachmentFilename(name: string): string {
  const leaf = name.split(/[\\/]/).at(-1) ?? ''
  const clean = leaf
    .replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 180)
  if (!clean) return 'attachment.bin'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean
}

/** The system dialog chooses the destination; cancel never reads or writes bytes. */
export async function saveAttachment(
  sessionId: string,
  attachment: SessionAttachment,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted()
  if (!attachment.id) throw new Error('Attachment has no durable identity')
  const path = await save({
    title: t('sessions.saveAttachment'),
    defaultPath: attachmentFilename(attachment.name || 'attachment.bin'),
  })
  if (!path || signal.aborted) return false
  const read = attachment.kind === 'file' ? downloadFile : previewImage
  const blob = await read(sessionId, attachment.id, signal)
  signal.throwIfAborted()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  signal.throwIfAborted()
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  }
  await sessionAttachmentSave(path, attachment.id, btoa(chunks.join('')))
  return true
}

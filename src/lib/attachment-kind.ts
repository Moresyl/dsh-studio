import type { SessionAttachment } from '@/lib/ipc'

export function attachmentPreviewKind(
  attachment: Pick<SessionAttachment, 'kind' | 'name' | 'mediaType'>,
): 'image' | 'pdf' | 'text' {
  if (attachment.kind === 'image') return 'image'
  const media = attachment.mediaType?.split(';')[0]?.trim().toLowerCase()
  return media === 'application/pdf' || attachment.name?.trim().toLowerCase().endsWith('.pdf')
    ? 'pdf'
    : 'text'
}

import type { SessionAttachment } from '@/lib/ipc'

export type PresentationImageIssue = 'format' | 'size' | null

export function attachmentPreviewCanDismiss(adding: boolean): boolean {
  return !adding
}

export function presentationImageIssue(blob: Pick<Blob, 'size' | 'type'>): PresentationImageIssue {
  if (blob.size < 1 || blob.size > 16 * 1024 * 1024) return 'size'
  return ['image/png', 'image/jpeg', 'image/webp'].includes(blob.type.toLowerCase())
    ? null
    : 'format'
}

export function attachmentPreviewKind(
  attachment: Pick<SessionAttachment, 'kind' | 'name' | 'mediaType'>,
): 'image' | 'pdf' | 'text' {
  if (attachment.kind === 'image') return 'image'
  const media = attachment.mediaType?.split(';')[0]?.trim().toLowerCase()
  return media === 'application/pdf' || attachment.name?.trim().toLowerCase().endsWith('.pdf')
    ? 'pdf'
    : 'text'
}

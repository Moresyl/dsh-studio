import { expect, it } from 'vitest'
import {
  attachmentPreviewCanDismiss,
  attachmentPreviewKind,
  presentationImageIssue,
} from './attachment-kind'

it('recognizes PDF metadata and extensions without reclassifying images', () => {
  expect(attachmentPreviewKind({ kind: 'file', name: '报告.PDF', mediaType: null })).toBe('pdf')
  expect(
    attachmentPreviewKind({
      kind: 'file',
      name: null,
      mediaType: 'application/pdf; charset=binary',
    }),
  ).toBe('pdf')
  expect(attachmentPreviewKind({ kind: 'image', name: 'image.pdf', mediaType: null })).toBe('image')
  expect(attachmentPreviewKind({ kind: 'file', name: null, mediaType: null })).toBe('text')
})

it('reports presentation image format and size mismatches before native import', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp'])
    expect(presentationImageIssue({ type, size: 16 * 1024 * 1024 })).toBeNull()
  expect(presentationImageIssue({ type: 'image/gif', size: 4 })).toBe('format')
  expect(presentationImageIssue({ type: 'image/png', size: 0 })).toBe('size')
  expect(presentationImageIssue({ type: 'image/png', size: 16 * 1024 * 1024 + 1 })).toBe('size')
})

it('keeps an admitted image operation visible until its result is known', () => {
  expect(attachmentPreviewCanDismiss(false)).toBe(true)
  expect(attachmentPreviewCanDismiss(true)).toBe(false)
})

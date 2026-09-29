import { expect, it } from 'vitest'
import { attachmentPreviewKind } from './attachment-kind'

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

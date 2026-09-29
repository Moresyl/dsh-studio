import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  downloadFile: vi.fn(),
  previewImage: vi.fn(),
  sessionAttachmentSave: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }))
vi.mock('@/lib/attachment-preview', () => mocks)
vi.mock('@/lib/ipc', () => mocks)
import { attachmentFilename, saveAttachment } from './attachment-save'
import type { SessionAttachment } from './ipc'

const attachment: SessionAttachment = {
  id: `sha256:${'a'.repeat(64)}`,
  kind: 'file',
  name: '../report.bin',
  bytes: 3,
  mediaType: null,
  width: null,
  height: null,
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.save.mockResolvedValue('D:/selected/report.bin')
  mocks.downloadFile.mockResolvedValue(new Blob([Uint8Array.of(0, 255, 128)]))
})

it('offers a leaf filename and writes exact binary only after confirmation', async () => {
  expect(await saveAttachment('session', attachment, new AbortController().signal)).toBe(true)
  expect(mocks.save.mock.calls[0]?.[0].defaultPath).toBe('report.bin')
  expect(mocks.sessionAttachmentSave).toHaveBeenCalledWith(
    'D:/selected/report.bin',
    attachment.id,
    'AP+A',
  )
})

it('does not read or write after dialog cancellation or a closed preview', async () => {
  mocks.save.mockResolvedValue(null)
  expect(await saveAttachment('session', attachment, new AbortController().signal)).toBe(false)
  const controller = new AbortController()
  mocks.save.mockImplementation(async () => {
    controller.abort()
    return 'D:/file'
  })
  expect(await saveAttachment('session', attachment, controller.signal)).toBe(false)
  expect(mocks.downloadFile).not.toHaveBeenCalled()
  expect(mocks.sessionAttachmentSave).not.toHaveBeenCalled()
})

it('does not write failed or cancelled reads and propagates disk errors', async () => {
  mocks.downloadFile.mockRejectedValueOnce(new Error('denied'))
  await expect(saveAttachment('session', attachment, new AbortController().signal)).rejects.toThrow(
    'denied',
  )
  const controller = new AbortController()
  mocks.downloadFile.mockImplementationOnce(async () => {
    controller.abort()
    return new Blob()
  })
  await expect(saveAttachment('session', attachment, controller.signal)).rejects.toThrow()
  expect(mocks.sessionAttachmentSave).not.toHaveBeenCalled()
  mocks.sessionAttachmentSave.mockRejectedValueOnce(new Error('disk full'))
  await expect(saveAttachment('session', attachment, new AbortController().signal)).rejects.toThrow(
    'disk full',
  )
})

it('uses the authorized image reader for raster attachments', async () => {
  mocks.previewImage.mockResolvedValue(new Blob(['png']))
  await saveAttachment('session', { ...attachment, kind: 'image' }, new AbortController().signal)
  expect(mocks.previewImage).toHaveBeenCalledOnce()
  expect(mocks.downloadFile).not.toHaveBeenCalled()
})

it('rejects missing identity or pre-cancelled operations before opening a dialog', async () => {
  await expect(
    saveAttachment('s', { ...attachment, id: null }, new AbortController().signal),
  ).rejects.toThrow('identity')
  const controller = new AbortController()
  controller.abort()
  await expect(saveAttachment('s', attachment, controller.signal)).rejects.toThrow()
  expect(mocks.save).not.toHaveBeenCalled()
})

it.each([
  ['../../a.txt', 'a.txt'],
  ['C:\\folder\\a.bin', 'a.bin'],
  ['CON.txt', '_CON.txt'],
  ['nul', '_nul'],
  ['..', 'attachment.bin'],
  ['bad?.txt', 'bad_.txt'],
])('normalizes suggested filename %s', (name, expected) => {
  expect(attachmentFilename(name)).toBe(expected)
})

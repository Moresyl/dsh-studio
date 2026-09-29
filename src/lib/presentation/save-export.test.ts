import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  exportPresentationBackground: vi.fn(),
  presentationExportSave: vi.fn(),
  presentationImageRead: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }))
vi.mock('./export-background', () => ({
  exportPresentationBackground: mocks.exportPresentationBackground,
}))
vi.mock('@/lib/ipc', () => ({
  presentationExportSave: mocks.presentationExportSave,
  presentationImageRead: mocks.presentationImageRead,
}))
import { savePresentationExport } from './save-export'
import { fixture } from './fixtures.test-support'
import { imageElement } from './image.test-support'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.save.mockResolvedValue('C:/chosen/report.pptx')
  mocks.exportPresentationBackground.mockResolvedValue(new Uint8Array([80, 75, 3, 4]))
  mocks.presentationExportSave.mockResolvedValue(undefined)
})

it('exports a click-time snapshot through a filtered save dialog and native atomic write', async () => {
  const source = fixture()
  const before = structuredClone(source)
  const controller = new AbortController()
  const progress = vi.fn()
  const operation = savePresentationExport(source, controller.signal, progress)
  source.title = 'Changed during export'
  expect(await operation).toBe(true)
  expect(mocks.exportPresentationBackground).toHaveBeenCalledWith(before, controller.signal, {})
  expect(mocks.presentationExportSave).toHaveBeenCalledWith('C:/chosen/report.pptx', 'UEsDBA==')
  expect(mocks.save.mock.calls[0]![0].filters[0].extensions).toEqual(['pptx'])
  expect(progress.mock.calls.map(([phase]) => phase)).toEqual(['choosing', 'generating', 'saving'])
})

it('does not start work for invalid source, cancelled dialog or wrong extension', async () => {
  await expect(savePresentationExport({}, new AbortController().signal, vi.fn())).rejects.toThrow()
  expect(mocks.save).not.toHaveBeenCalled()
  mocks.save.mockResolvedValueOnce(null)
  expect(await savePresentationExport(fixture(), new AbortController().signal, vi.fn())).toBe(false)
  mocks.save.mockResolvedValueOnce('C:/chosen/report.exe')
  await expect(
    savePresentationExport(fixture(), new AbortController().signal, vi.fn()),
  ).rejects.toThrow('.pptx')
  expect(mocks.exportPresentationBackground).not.toHaveBeenCalled()
  expect(mocks.presentationExportSave).not.toHaveBeenCalled()
})

it('checks cancellation before work and again after the native dialog returns', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(savePresentationExport(fixture(), controller.signal, vi.fn())).rejects.toThrow()
  expect(mocks.save).not.toHaveBeenCalled()
  const later = new AbortController()
  mocks.save.mockImplementation(async () => {
    later.abort()
    return 'C:/chosen/report.pptx'
  })
  expect(await savePresentationExport(fixture(), later.signal, vi.fn())).toBe(false)
  expect(mocks.exportPresentationBackground).not.toHaveBeenCalled()
})

it('never writes a cancelled or failed generation and propagates disk errors', async () => {
  const controller = new AbortController()
  mocks.exportPresentationBackground.mockImplementationOnce(async () => {
    controller.abort()
    return new Uint8Array([80, 75])
  })
  await expect(savePresentationExport(fixture(), controller.signal, vi.fn())).rejects.toThrow()
  expect(mocks.presentationExportSave).not.toHaveBeenCalled()
  mocks.exportPresentationBackground.mockRejectedValueOnce(new Error('generation failed'))
  await expect(
    savePresentationExport(fixture(), new AbortController().signal, vi.fn()),
  ).rejects.toThrow('generation failed')
  expect(mocks.presentationExportSave).not.toHaveBeenCalled()
  mocks.presentationExportSave.mockRejectedValueOnce(new Error('disk failed'))
  await expect(
    savePresentationExport(fixture(), new AbortController().signal, vi.fn()),
  ).rejects.toThrow('disk failed')
})

it('preserves the destination when a referenced image is damaged', async () => {
  const source = fixture()
  source.version = 2
  source.slides[0]!.elements = [imageElement()]
  mocks.presentationImageRead.mockRejectedValue(new Error('image resource is damaged'))
  await expect(
    savePresentationExport(source, new AbortController().signal, vi.fn()),
  ).rejects.toThrow('image resource is damaged')
  expect(mocks.exportPresentationBackground).not.toHaveBeenCalled()
  expect(mocks.presentationExportSave).not.toHaveBeenCalled()
})

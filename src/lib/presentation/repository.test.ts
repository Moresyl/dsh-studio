import { beforeEach, expect, it, vi } from 'vitest'
const ipc = vi.hoisted(() => ({
  presentationLoad: vi.fn(),
  presentationSave: vi.fn(),
  presentationImageRead: vi.fn(),
}))
vi.mock('@/lib/ipc', () => ipc)
import { loadPresentation, savePresentation } from './repository'
import { fixture } from './fixtures.test-support'
import { imageElement } from './image.test-support'
const revision = 'a'.repeat(64)

beforeEach(() => vi.resetAllMocks())

it('loads validated detached sources and distinguishes missing files', async () => {
  const document = fixture()
  ipc.presentationLoad.mockResolvedValueOnce({ document, revision }).mockResolvedValueOnce(null)
  const saved = await loadPresentation('fixture')
  expect(saved).toEqual({ document, revision })
  expect(saved!.document).not.toBe(document)
  expect(await loadPresentation('missing')).toBeNull()
})

it('rejects damaged or mismatched saved sources before editing', async () => {
  for (const value of [
    { document: {}, revision },
    { document: fixture(), revision: 'invalid' },
    { document: { ...fixture(), id: 'other' }, revision },
  ]) {
    ipc.presentationLoad.mockResolvedValueOnce(value)
    await expect(loadPresentation('fixture')).rejects.toThrow()
  }
})

it('refuses a source with missing image bytes before returning it to the editor', async () => {
  const document = fixture()
  document.version = 2
  document.slides[0]!.elements = [imageElement()]
  const before = structuredClone(document)
  ipc.presentationLoad.mockResolvedValue({ document, revision })
  ipc.presentationImageRead.mockRejectedValue(new Error('image resource is missing'))
  await expect(loadPresentation('fixture')).rejects.toThrow('image resource is missing')
  expect(document).toEqual(before)
  expect(ipc.presentationSave).not.toHaveBeenCalled()
})

it('validates before writing and carries the exact revision to native storage', async () => {
  const document = fixture()
  ipc.presentationSave.mockResolvedValue({ document, revision })
  await savePresentation(document, null)
  expect(ipc.presentationSave).toHaveBeenLastCalledWith('fixture', JSON.stringify(document), null)
  await savePresentation(document, revision)
  expect(ipc.presentationSave).toHaveBeenLastCalledWith(
    'fixture',
    JSON.stringify(document),
    revision,
  )
  await expect(savePresentation({}, null)).rejects.toThrow()
  await expect(savePresentation(document, 'invalid')).rejects.toThrow('revision')
  expect(ipc.presentationSave).toHaveBeenCalledTimes(2)
})

it('does not hide native conflicts or replace a failed save with empty content', async () => {
  const error = new Error('document changed in another window')
  ipc.presentationSave.mockRejectedValue(error)
  await expect(savePresentation(fixture(), revision)).rejects.toBe(error)
  ipc.presentationLoad.mockRejectedValue(error)
  await expect(loadPresentation('fixture')).rejects.toBe(error)
  expect(ipc.presentationSave).toHaveBeenCalledOnce()
})

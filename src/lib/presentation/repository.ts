import * as ipc from '@/lib/ipc'
import { parsePresentation, PresentationError, type PresentationDocument } from './document'
import { documentImages } from './media'

export interface SavedDocument {
  document: PresentationDocument
  revision: string
}

function checked(value: ipc.SavedPresentation, id: string): SavedDocument {
  const document = parsePresentation(value.document)
  if (document.id !== id || !/^[a-f0-9]{64}$/.test(value.revision))
    throw new PresentationError('storage', 'invalid saved document identity')
  return { document, revision: value.revision }
}

/** Never promote unsupported or damaged sources into editable state. */
export async function loadPresentation(id: string): Promise<SavedDocument | null> {
  const value = await ipc.presentationLoad(id)
  if (value === null) return null
  const saved = checked(value, id)
  await documentImages(saved.document)
  return saved
}

/** Null means create-only; an existing source always needs its last read revision. */
export async function savePresentation(
  source: unknown,
  revision: string | null,
): Promise<SavedDocument> {
  const document = parsePresentation(source)
  if (revision !== null && !/^[a-f0-9]{64}$/.test(revision))
    throw new PresentationError('storage', 'invalid document revision')
  const saved = await ipc.presentationSave(document.id, JSON.stringify(document), revision)
  return checked(saved, document.id)
}

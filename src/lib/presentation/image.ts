import type { PresentationImage } from '@/lib/ipc'
import { PresentationError } from './document'

const PREFIX = 'data:image/png;base64,'
const LIMIT = 8 * 1024 * 1024

/** Resource payloads never contain remote URLs, SVG or caller-controlled MIME types. */
export function validateImage(value: PresentationImage, expected = value?.id): PresentationImage {
  if (
    !value ||
    !/^[a-f0-9]{64}$/.test(value.id) ||
    value.id !== expected ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 8192 ||
    value.height > 8192 ||
    value.width * value.height > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > LIMIT ||
    typeof value.dataUrl !== 'string' ||
    !value.dataUrl.startsWith(PREFIX)
  )
    throw new PresentationError('image', 'invalid image resource response')
  const encoded = value.dataUrl.slice(PREFIX.length)
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  if (
    encoded.length !== Math.ceil(value.bytes / 3) * 4 ||
    (encoded.length / 4) * 3 - padding !== value.bytes ||
    /[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding))
  )
    throw new PresentationError('image', 'invalid image resource data')
  const header = atob(encoded.slice(0, 32))
  if (!header.startsWith('\x89PNG\r\n\x1a\n') || header.slice(12, 16) !== 'IHDR')
    throw new PresentationError('image', 'invalid image resource header')
  const dimension = (offset: number) =>
    header.charCodeAt(offset) * 2 ** 24 +
    header.charCodeAt(offset + 1) * 2 ** 16 +
    header.charCodeAt(offset + 2) * 256 +
    header.charCodeAt(offset + 3)
  if (dimension(16) !== value.width || dimension(20) !== value.height)
    throw new PresentationError('image', 'image resource dimensions do not match')
  return value
}

import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import type { PresentationImage } from '@/lib/ipc'
import type { ImageElement } from './document'

/** A tiny original RGB fixture with valid PNG checksums, independent of the app decoder. */
export function imageFixture(width = 3, height = 2): PresentationImage {
  const chunk = (name: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(name), data])
    let crc = 0xffffffff
    for (const byte of typed) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, typed, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3
      pixels[at] = x % 2 ? 230 : 30
      pixels[at + 1] = y % 2 ? 180 : 40
      pixels[at + 2] = 160
    }
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return {
    id: createHash('sha256').update(bytes).digest('hex'),
    width,
    height,
    bytes: bytes.length,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  }
}

export function imageElement(image = imageFixture()): ImageElement {
  return {
    id: 'picture',
    kind: 'image',
    asset: image.id,
    alt: 'Original <picture> & "label"',
    fit: 'contain',
    x: 40,
    y: 40,
    width: 300,
    height: 300,
    rotation: 15,
  }
}

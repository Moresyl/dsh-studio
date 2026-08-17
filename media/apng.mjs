/**
 * Frames in, one animated PNG out.
 *
 * The README needs the two animations to play on github.com, which rules out
 * video: a `<video>` tag does not survive the Markdown sanitiser, and a GIF
 * would have to quantise a dark UI full of one-percent surface steps down to 256
 * colours and dither the result. APNG is lossless, plays inline in every browser
 * GitHub supports, and is a PNG — so anything that cannot animate it still shows
 * the first frame, which is the frame that was chosen to be the poster anyway.
 *
 * Nothing here needs a dependency. An APNG is an ordinary PNG with three extra
 * chunk types, and the captures come out of the browser already 8-bit truecolour
 * and non-interlaced, so the work is: inflate each frame, find the rectangle
 * that actually changed, and re-deflate only that. Most frames in these scenes
 * move a cursor and one line of text, which is why the finished file is a
 * fraction of the sum of its frames.
 *
 *     node media/apng.mjs <frame-dir> <out.png>
 *
 * where the directory holds `frame-000.png`, `frame-001.png`, … and a
 * `plan.json` array of per-frame holds in milliseconds, as reported by
 * `window.dsh.plan()`.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/* -------------------------------------------------------------------------- */
/* Chunks                                                                     */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = new Int32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value
}

const crc32 = (buffer) => {
  let value = -1
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ -1) >>> 0
}

const chunk = (type, data) => {
  const frame = Buffer.alloc(12 + data.length)
  frame.writeUInt32BE(data.length, 0)
  frame.write(type, 4, 'latin1')
  data.copy(frame, 8)
  frame.writeUInt32BE(crc32(frame.subarray(4, 8 + data.length)), 8 + data.length)
  return frame
}

/* -------------------------------------------------------------------------- */
/* Reading a capture                                                          */
/* -------------------------------------------------------------------------- */

/** Undo the per-scanline predictor a PNG encoder chose. */
const unfilter = (raw, width, height, channels) => {
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  let source = 0

  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const line = pixels.subarray(y * stride, (y + 1) * stride)
    const above = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      const up = above ? above[x] : 0
      const corner = above && x >= channels ? above[x - channels] : 0
      let predicted = 0

      switch (filter) {
        case 0:
          break
        case 1:
          predicted = left
          break
        case 2:
          predicted = up
          break
        case 3:
          predicted = (left + up) >> 1
          break
        case 4: {
          const estimate = left + up - corner
          const dLeft = Math.abs(estimate - left)
          const dUp = Math.abs(estimate - up)
          const dCorner = Math.abs(estimate - corner)
          predicted = dLeft <= dUp && dLeft <= dCorner ? left : dUp <= dCorner ? up : corner
          break
        }
        default:
          throw new Error(`apng: unknown scanline filter ${filter}`)
      }

      line[x] = (raw[source + x] + predicted) & 0xff
    }

    source += stride
  }

  return pixels
}

const read = (file) => {
  const buffer = readFileSync(file)
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error(`apng: ${file} is not a PNG`)

  let header = null
  const compressed = []
  let offset = 8

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colour: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') {
      compressed.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length
  }

  if (!header) throw new Error(`apng: ${file} has no IHDR`)
  if (
    header.depth !== 8 ||
    (header.colour !== 2 && header.colour !== 6) ||
    header.interlace !== 0
  ) {
    throw new Error(
      `apng: ${file} is depth ${header.depth} colour ${header.colour} interlace ${header.interlace}; ` +
        'expected an 8-bit non-interlaced truecolour capture',
    )
  }

  const channels = header.colour === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(compressed))

  return {
    width: header.width,
    height: header.height,
    channels,
    pixels: unfilter(raw, header.width, header.height, channels),
  }
}

/* -------------------------------------------------------------------------- */
/* Writing one frame                                                          */
/* -------------------------------------------------------------------------- */

/** How well a filtered scanline is likely to deflate: smaller residuals win. */
const cost = (line) => {
  let total = 0
  for (let index = 1; index < line.length; index += 1) {
    const byte = line[index]
    total += byte < 128 ? byte : 256 - byte
  }
  return total
}

const filtered = (line, above, channels, filter) => {
  const out = Buffer.alloc(line.length + 1)
  out[0] = filter

  for (let x = 0; x < line.length; x += 1) {
    const left = x >= channels ? line[x - channels] : 0
    const up = above[x]
    const corner = x >= channels ? above[x - channels] : 0
    let predicted = 0

    switch (filter) {
      case 1:
        predicted = left
        break
      case 2:
        predicted = up
        break
      case 3:
        predicted = (left + up) >> 1
        break
      case 4: {
        const estimate = left + up - corner
        const dLeft = Math.abs(estimate - left)
        const dUp = Math.abs(estimate - up)
        const dCorner = Math.abs(estimate - corner)
        predicted = dLeft <= dUp && dLeft <= dCorner ? left : dUp <= dCorner ? up : corner
        break
      }
      default:
        break
    }

    out[x + 1] = (line[x] - predicted) & 0xff
  }

  return out
}

/** Deflate one rectangle of a frame, picking a predictor per scanline. */
const compress = (frame, region) => {
  const stride = frame.width * frame.channels
  const span = region.width * frame.channels
  const lines = []
  let above = Buffer.alloc(span)

  for (let y = 0; y < region.height; y += 1) {
    const start = (region.y + y) * stride + region.x * frame.channels
    const line = frame.pixels.subarray(start, start + span)

    let best = null
    for (let filter = 0; filter <= 4; filter += 1) {
      const candidate = filtered(line, above, frame.channels, filter)
      const score = cost(candidate)
      if (best === null || score < best.score) best = { candidate, score }
    }

    lines.push(best.candidate)
    above = line
  }

  return deflateSync(Buffer.concat(lines), { level: 9 })
}

/**
 * The rectangle that changed, or null when nothing did.
 *
 * This is where the file size comes from. A frame that only slides a cursor
 * three pixels is a rectangle about the size of the cursor, and a frame that
 * adds a line of npm output is a strip the height of that line.
 */
const changed = (previous, next) => {
  const { width, height, channels } = next
  const stride = width * channels
  let top = -1
  let bottom = -1
  let left = width
  let right = -1

  for (let y = 0; y < height; y += 1) {
    const start = y * stride
    if (previous.pixels.compare(next.pixels, start, start + stride, start, start + stride) === 0) {
      continue
    }

    if (top === -1) top = y
    bottom = y

    for (let x = 0; x < width; x += 1) {
      const at = start + x * channels
      let same = true
      for (let byte = 0; byte < channels; byte += 1) {
        if (previous.pixels[at + byte] !== next.pixels[at + byte]) {
          same = false
          break
        }
      }
      if (same) continue
      if (x < left) left = x
      if (x > right) right = x
    }
  }

  if (top === -1) return null
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

const build = (frames, holds) => {
  const first = frames[0]

  // Every frame is a rectangle of the one before it, kept rather than cleared,
  // so the canvas is cumulative: dispose NONE, blend SOURCE.
  const parts = []
  let sequence = 0

  const fcTL = (region, hold) => {
    const data = Buffer.alloc(26)
    data.writeUInt32BE(sequence, 0)
    sequence += 1
    data.writeUInt32BE(region.width, 4)
    data.writeUInt32BE(region.height, 8)
    data.writeUInt32BE(region.x, 12)
    data.writeUInt32BE(region.y, 16)
    data.writeUInt16BE(Math.min(0xffff, Math.round(hold)), 20)
    data.writeUInt16BE(1000, 22)
    data[24] = 0
    data[25] = 0
    return chunk('fcTL', data)
  }

  // Collected before anything is written, because a frame that turned out to be
  // identical to the one before it is not a frame — its time is handed to its
  // predecessor instead.
  const shots = [
    {
      region: { x: 0, y: 0, width: first.width, height: first.height },
      hold: holds[0],
      frame: first,
    },
  ]

  for (let index = 1; index < frames.length; index += 1) {
    const region = changed(frames[index - 1], frames[index])
    if (!region) {
      shots.at(-1).hold += holds[index]
      continue
    }
    shots.push({ region, hold: holds[index], frame: frames[index] })
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(first.width, 0)
  ihdr.writeUInt32BE(first.height, 4)
  ihdr[8] = 8
  ihdr[9] = first.channels === 4 ? 6 : 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const actl = Buffer.alloc(8)
  actl.writeUInt32BE(shots.length, 0)
  actl.writeUInt32BE(0, 4)

  parts.push(SIGNATURE, chunk('IHDR', ihdr), chunk('acTL', actl))

  const sizes = []

  shots.forEach((shot, index) => {
    parts.push(fcTL(shot.region, shot.hold))
    const data = compress(shot.frame, shot.region)
    sizes.push({ region: shot.region, bytes: data.length, hold: shot.hold })

    if (index === 0) {
      parts.push(chunk('IDAT', data))
      return
    }

    const body = Buffer.alloc(4 + data.length)
    body.writeUInt32BE(sequence, 0)
    sequence += 1
    data.copy(body, 4)
    parts.push(chunk('fdAT', body))
  })

  parts.push(chunk('IEND', Buffer.alloc(0)))
  return { file: Buffer.concat(parts), sizes }
}

/* -------------------------------------------------------------------------- */

const [directory, output] = process.argv.slice(2)
if (!directory || !output) {
  console.error('usage: node media/apng.mjs <frame-dir> <out.png>')
  process.exit(2)
}

const holds = JSON.parse(readFileSync(join(directory, 'plan.json'), 'utf8'))
const files = readdirSync(directory)
  .filter((name) => /^frame-\d+\.png$/.test(name))
  .sort()

if (files.length === 0) throw new Error(`apng: no frames in ${directory}`)
if (files.length !== holds.length) {
  throw new Error(`apng: ${files.length} frames but ${holds.length} holds in plan.json`)
}

const frames = files.map((name) => read(join(directory, name)))
const size = frames[0]
for (const frame of frames) {
  if (frame.width !== size.width || frame.height !== size.height) {
    throw new Error('apng: the frames are not all the same size')
  }
}

const { file, sizes } = build(frames, holds)
writeFileSync(output, file)

const kilobytes = (bytes) => `${(bytes / 1024).toFixed(1)}kB`
const source = files.reduce((total, name) => total + readFileSync(join(directory, name)).length, 0)

console.log(`${basename(output)}  ${size.width}x${size.height}  ${sizes.length} frames`)
console.log(`  ${kilobytes(file.length)} out, from ${kilobytes(source)} of captures`)
console.log(
  `  largest frame ${kilobytes(Math.max(...sizes.map((entry) => entry.bytes)))}, ` +
    `total hold ${(sizes.reduce((total, entry) => total + entry.hold, 0) / 1000).toFixed(1)}s`,
)

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  imageBlob,
  textBlob,
  fileBlob,
  downloadFile,
  IMAGE_LIMIT,
  previewImage,
  previewText,
  serveImagePreview,
} from './attachment-preview'

const id = `sha256:${'a'.repeat(64)}`
const origin = 'http://127.0.0.1:12345'
const valid = () => ({
  attachment: { attachmentId: id, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
  data: 'YWJj',
})
const listeners = new Set<(event: MessageEvent) => void>()
const disposers: Array<() => void> = []
const signal = () => new AbortController().signal

it('downloads opaque bytes through the bound frame and rejects malformed payloads', async () => {
  await expect(downloadFile('s', id, signal())).rejects.toThrow('Start Harness')
  const c = connection()
  const waiting = downloadFile('s', id, signal())
  expect(c.postMessage.mock.calls[0]?.[0].kind).toBe('download')
  c.reply({ value: { attachmentId: id, bytes: 3, data: 'AP+A' } })
  const blob = await waiting
  expect(blob.type).toBe('application/octet-stream')
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0, 255, 128])
  for (const patch of [
    { attachmentId: 'other' },
    { bytes: -1 },
    { bytes: IMAGE_LIMIT + 1 },
    { bytes: 2 },
    { data: '!' },
    { data: 'AP+A\n' },
  ]) {
    expect(() => fileBlob({ attachmentId: id, bytes: 3, data: 'AP+A', ...patch }, id)).toThrow()
  }
  expect(fileBlob({ attachmentId: id, bytes: 0, data: '' }, id).size).toBe(0)
})
function connection() {
  const postMessage = vi.fn()
  const peer = { postMessage } as unknown as Window
  const dispose = serveImagePreview(peer, origin)
  disposers.push(dispose)
  const reply = (changes = {}, source: unknown = peer, address = origin) => {
    const request = postMessage.mock.calls.at(-1)?.[0]
    for (const listener of listeners)
      listener({
        source,
        origin: address,
        data: {
          type: 'dsh-studio:image-result',
          id: request?.id,
          ok: true,
          value: valid(),
          ...changes,
        },
      } as MessageEvent)
  }
  return { peer, postMessage, dispose, reply }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    addEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MessageEvent) => void) => listeners.delete(fn),
  })
})
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  listeners.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('creates an image blob only for the expected bounded raster record', async () => {
  const blob = imageBlob(valid(), id)
  expect(blob.type).toBe('image/png')
  expect(await blob.text()).toBe('abc')
  for (const patch of [
    { attachmentId: 'other' },
    { mediaType: 'image/svg+xml' },
    { bytes: 0 },
    { bytes: IMAGE_LIMIT + 1 },
    { bytes: 1.5 },
    { width: 0 },
    { height: 0 },
    { width: 8193 },
    { height: 8193 },
    { width: 8192, height: 8192 },
  ]) {
    expect(() =>
      imageBlob({ ...valid(), attachment: { ...valid().attachment, ...patch } }, id),
    ).toThrow()
  }
  expect(() => imageBlob(null, id)).toThrow()
  for (const data of [
    '!',
    'YWJj\n',
    'YQ==',
    'x'.repeat(Math.ceil(IMAGE_LIMIT / 3) * 4 + 1),
    null,
  ]) {
    expect(() => imageBlob({ ...valid(), data }, id)).toThrow()
  }
})

it('requires a live frame and validates identities before sending', async () => {
  await expect(previewImage('s', id, signal())).rejects.toThrow('Start Harness')
  const c = connection()
  for (const [session, attachment] of [
    ['', id],
    ['x'.repeat(513), id],
    ['s', '../../file'],
  ] as const) {
    await expect(previewImage(session, attachment, signal())).rejects.toThrow('identity')
  }
  const aborted = new AbortController()
  aborted.abort()
  await expect(previewImage('s', id, aborted.signal)).rejects.toThrow('cancelled')
  expect(c.postMessage).not.toHaveBeenCalled()
})

it('accepts only the exact frame, origin, response type and request id', async () => {
  const c = connection()
  const pending = previewImage('s', id, signal())
  c.reply({}, {}, origin)
  c.reply({}, c.peer, 'http://127.0.0.1:9999')
  c.reply({ type: 'other' })
  c.reply({ id: 'unknown' })
  expect(vi.getTimerCount()).toBe(1)
  c.reply()
  expect(await (await pending).text()).toBe('abc')
  expect(c.postMessage.mock.calls[0]?.[1]).toBe(origin)
  expect(vi.getTimerCount()).toBe(0)
  c.reply()
})

it('rejects denied and malformed responses without exposing backend details', async () => {
  const c = connection()
  const denied = previewImage('s', id, signal())
  c.reply({ ok: false, error: 'private path' })
  await expect(denied).rejects.toThrow('could not authorize')
  const malformed = previewImage('s', id, signal())
  c.reply({ value: {} })
  await expect(malformed).rejects.toThrow('Invalid')
})

it('cancels, times out and retires requests without accepting late replies', async () => {
  const c = connection(),
    controller = new AbortController()
  const cancelled = previewImage('s', id, controller.signal)
  controller.abort()
  await expect(cancelled).rejects.toThrow('cancelled')
  c.reply()
  const timeout = previewImage('s', id, signal())
  const assertion = expect(timeout).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(20_000)
  await assertion
  const retiring = previewImage('s', id, signal())
  c.dispose()
  await expect(retiring).rejects.toThrow('connection ended')
  expect(vi.getTimerCount()).toBe(0)
})

it('limits concurrent requests and preserves a newer frame on old cleanup', async () => {
  const old = connection()
  const waiting = Array.from({ length: 4 }, () =>
    previewImage('s', id, signal()).catch((error) => error.message),
  )
  await expect(previewImage('s', id, signal())).rejects.toThrow('Too many')
  const fresh = connection()
  old.dispose()
  expect(await Promise.all(waiting)).toEqual(Array(4).fill('Harness connection ended'))
  const result = previewImage('s', id, signal())
  fresh.reply()
  expect((await result).size).toBe(3)
})

it('releases a request when postMessage fails', async () => {
  const c = connection()
  c.postMessage.mockImplementation(() => {
    throw Error('closed')
  })
  await expect(previewImage('s', id, signal())).rejects.toThrow('unavailable')
  expect(vi.getTimerCount()).toBe(0)
})

it('validates plain text replies including empty files, Unicode and BOM', async () => {
  for (const text of ['', '中文 <script>alert(1)</script>', '\ufefftext']) {
    const blob = textBlob(
      { attachmentId: id, bytes: new TextEncoder().encode(text).length, text },
      id,
    )
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(blob.size).toBe(new TextEncoder().encode(text).length)
  }
  for (const reply of [
    null,
    {},
    { attachmentId: id, bytes: 0, text: 1 },
    { attachmentId: id, bytes: -1, text: '' },
    { attachmentId: id, bytes: 1048577, text: '' },
    { attachmentId: id, bytes: 1, text: 'abc' },
    { attachmentId: id, bytes: 1, text: '\0' },
    { attachmentId: id, bytes: 1, text: 'x'.repeat(1048577) },
  ])
    expect(() => textBlob(reply, id)).toThrow()
})

it('routes file previews separately and enforces the text reply contract', async () => {
  await expect(previewText('s', id, signal())).rejects.toThrow('Start Harness')
  const c = connection()
  const result = previewText('s', id, signal())
  expect(c.postMessage.mock.calls.at(-1)?.[0].kind).toBe('file')
  c.reply({ value: { attachmentId: id, bytes: 3, text: 'abc' } })
  expect(await (await result).text()).toBe('abc')
  const wrong = previewText('s', id, signal())
  c.reply()
  await expect(wrong).rejects.toThrow('Invalid text')
})

it('cancels the matching host file read when the caller closes its preview', async () => {
  const c = connection(),
    controller = new AbortController()
  const result = previewText('s', id, controller.signal)
  const request = c.postMessage.mock.calls[0]?.[0]
  controller.abort()
  await expect(result).rejects.toThrow('cancelled')
  expect(c.postMessage.mock.calls.at(-1)).toEqual([
    { type: 'dsh-studio:preview-cancel', id: request.id },
    origin,
  ])
})

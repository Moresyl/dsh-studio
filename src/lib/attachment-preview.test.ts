import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { imageBlob, IMAGE_LIMIT, previewImage, serveImagePreview } from './attachment-preview'

const id = `sha256:${'a'.repeat(64)}`
const origin = 'http://127.0.0.1:12345'
const valid = () => ({
  attachment: { attachmentId: id, mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
  data: 'YWJj',
})
const listeners = new Set<(event: MessageEvent) => void>()
const disposers: Array<() => void> = []
const signal = () => new AbortController().signal
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

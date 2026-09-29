import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { exportPresentationBackground } from './export-background'
import { fixture } from './fixtures.test-support'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { preventDefault: () => void }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminate = vi.fn()
  postMessage = vi.fn()
  constructor() {
    FakeWorker.instances.push(this)
  }
}
const latest = () => FakeWorker.instances.at(-1)!
beforeEach(() => {
  FakeWorker.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('exports a detached document and terminates after receiving bounded bytes', async () => {
  const source = fixture()
  const operation = exportPresentationBackground(source, new AbortController().signal)
  expect(latest().postMessage).toHaveBeenCalledWith({ document: source, images: {} })
  expect(latest().postMessage.mock.calls[0]![0].document).not.toBe(source)
  latest().onmessage!({ data: { bytes: new Uint8Array([80, 75, 3, 4]).buffer } })
  expect(await operation).toEqual(new Uint8Array([80, 75, 3, 4]))
  expect(latest().terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects invalid or already cancelled requests without starting a worker', async () => {
  await expect(exportPresentationBackground({}, new AbortController().signal)).rejects.toThrow()
  const controller = new AbortController()
  controller.abort()
  await expect(exportPresentationBackground(fixture(), controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(FakeWorker.instances).toHaveLength(0)
})

it('terminates cancellation and timeout instead of leaving compression running', async () => {
  const controller = new AbortController()
  const cancelled = exportPresentationBackground(fixture(), controller.signal)
  controller.abort()
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  const timeout = expect(
    exportPresentationBackground(fixture(), new AbortController().signal),
  ).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(30_000)
  await timeout
  for (const worker of FakeWorker.instances) expect(worker.terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  null,
  { failed: true },
  { bytes: new ArrayBuffer(0) },
  { bytes: new ArrayBuffer(20 * 1024 * 1024 + 1) },
])('rejects malformed or oversized worker replies', async (data) => {
  const operation = exportPresentationBackground(fixture(), new AbortController().signal)
  latest().onmessage!({ data })
  await expect(operation).rejects.toThrow('could not create')
  expect(latest().terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('cleans up on worker errors without exposing worker details', async () => {
  const operation = exportPresentationBackground(fixture(), new AbortController().signal)
  const preventDefault = vi.fn()
  latest().onerror!({ preventDefault })
  await expect(operation).rejects.toThrow('background export failed')
  expect(preventDefault).toHaveBeenCalledOnce()
  const unreadable = exportPresentationBackground(fixture(), new AbortController().signal)
  latest().onmessageerror!()
  await expect(unreadable).rejects.toThrow('could not read')
  for (const worker of FakeWorker.instances) expect(worker.terminate).toHaveBeenCalledOnce()
})

it('handles unavailable workers and structured clone failures', async () => {
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('private path')
      }
    },
  )
  await expect(
    exportPresentationBackground(fixture(), new AbortController().signal),
  ).rejects.toThrow('could not start')
  vi.stubGlobal(
    'Worker',
    class extends FakeWorker {
      postMessage = vi.fn(() => {
        throw new Error('private source')
      })
    },
  )
  await expect(
    exportPresentationBackground(fixture(), new AbortController().signal),
  ).rejects.toThrow('could not start')
  expect(latest().terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

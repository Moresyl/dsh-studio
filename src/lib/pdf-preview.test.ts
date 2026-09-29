import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  create: vi.fn(),
  workerDestroy: vi.fn(),
  taskDestroy: vi.fn(),
  terminate: vi.fn(),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: mocks.getDocument,
  PDFWorker: { create: mocks.create },
}))
import { openPdf, pdfGeometry } from './pdf-preview'

const blob = () => new Blob(['%PDF-1.7\nfixture'])
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal(
    'Worker',
    class {
      terminate = mocks.terminate
    },
  )
  vi.stubGlobal('location', { href: 'http://127.0.0.1:1234/' })
  mocks.create.mockReturnValue({ destroy: mocks.workerDestroy })
  mocks.taskDestroy.mockResolvedValue(undefined)
  mocks.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 2 }),
    destroy: mocks.taskDestroy,
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('loads only supplied bytes with local resources and owns idempotent cleanup', async () => {
  const session = await openPdf(blob(), new AbortController().signal, 'secret')
  expect(session.document.numPages).toBe(2)
  expect(mocks.getDocument.mock.calls[0]?.[0]).toMatchObject({
    password: 'secret',
    enableXfa: false,
    cMapUrl: 'http://127.0.0.1:1234/pdfjs/cmaps/',
  })
  expect(mocks.getDocument.mock.calls[0]?.[0].url).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
  session.close()
  session.close()
  expect(mocks.terminate).toHaveBeenCalledOnce()
  expect(mocks.workerDestroy).toHaveBeenCalledOnce()
  expect(mocks.taskDestroy).toHaveBeenCalledOnce()
})

it('rejects invalid, oversized and cancelled input before creating a worker', async () => {
  await expect(openPdf(new Blob(['HTML']), new AbortController().signal)).rejects.toThrow('header')
  await expect(
    openPdf(new Blob([new Uint8Array(20 * 1024 * 1024 + 1)]), new AbortController().signal),
  ).rejects.toThrow('limit')
  const controller = new AbortController()
  controller.abort()
  await expect(openPdf(blob(), controller.signal)).rejects.toThrow()
  expect(mocks.create).not.toHaveBeenCalled()
})

it('terminates a stalled parser on cancellation and timeout', async () => {
  mocks.getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy: mocks.taskDestroy })
  const controller = new AbortController()
  const cancelled = openPdf(blob(), controller.signal)
  const rejected = expect(cancelled).rejects.toThrow('cancelled')
  await vi.advanceTimersByTimeAsync(1)
  controller.abort()
  await rejected
  const timeout = expect(openPdf(blob(), new AbortController().signal)).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(20_000)
  await timeout
  expect(mocks.terminate).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves password errors and reclaims workers after setup errors', async () => {
  const password = Object.assign(new Error('password'), { name: 'PasswordException' })
  mocks.getDocument.mockImplementationOnce(() => ({
    promise: Promise.reject(password),
    destroy: mocks.taskDestroy,
  }))
  await expect(openPdf(blob(), new AbortController().signal)).rejects.toBe(password)
  mocks.getDocument.mockImplementationOnce(() => {
    throw Error('setup')
  })
  await expect(openPdf(blob(), new AbortController().signal)).rejects.toThrow('setup')
  expect(mocks.terminate).toHaveBeenCalledTimes(2)
})

it('bounds page raster memory while fitting and zooming normal and extreme dimensions', () => {
  expect(pdfGeometry(600, 800, 600, 1, 1)).toMatchObject({ scale: 1, width: 600, height: 800 })
  for (const [width, height] of [
    [600, 800],
    [100000, 100000],
    [1, 100000],
    [Number.MAX_VALUE, Number.MAX_VALUE],
  ]) {
    const geometry = pdfGeometry(width!, height!, 900, 2, 4)
    expect(geometry.width * geometry.height).toBeLessThanOrEqual(8_000_000)
    expect(geometry.scale).toBeGreaterThan(0)
  }
  expect(() => pdfGeometry(0, 10, 10, 1, 1)).toThrow()
  expect(() => pdfGeometry(Infinity, 10, 10, 1, 1)).toThrow()
  expect(() => pdfGeometry(Number.MIN_VALUE, Number.MIN_VALUE, 600, 1, 1)).toThrow()
})

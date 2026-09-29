import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  FILE_PREVIEW_BYTES,
  FILE_PREVIEW_ROUTE,
  FILE_DOWNLOAD_BYTES,
  FILE_DOWNLOAD_ROUTE,
  readFileDownload,
  readFilePreview,
  registerFilePreview,
} from '../../src-tauri/runtime-contract/dsh-studio-integration/lib/file-preview.js'

function fixture(data = Buffer.from('中文 <script>alert(1)</script>\n')) {
  const id = `sha256:${createHash('sha256').update(data).digest('hex')}`
  const ref = { attachmentId: id, bytes: data.length, name: '../../private.txt' }
  const events = [{ type: 'user/message', data: { content: [{ type: 'file', attachment: ref }] } }]
  let reads = 0
  const ctx = {
    sessionQuery: {
      observeSession: async (session, options) => {
        assert.equal(session, 'session')
        options.signal.throwIfAborted()
        return { events, [Symbol.dispose]() {} }
      },
    },
    attachments: {
      async *readFileStream(actual, signal) {
        reads++
        assert.equal(actual, ref)
        signal.throwIfAborted()
        yield data
      },
    },
  }
  return { ctx, ref, id, data, events, reads: () => reads }
}
const signal = () => new AbortController().signal
const read = (f) => readFilePreview(f.ctx, 'session', f.id, signal())

test('original downloads preserve binary and empty content while enforcing session references and size', async () => {
  for (const bytes of [
    Buffer.from([0, 255, 128, 1]),
    Buffer.alloc(0),
    Buffer.alloc(FILE_PREVIEW_BYTES + 1),
  ]) {
    const f = fixture(bytes)
    assert.deepEqual(await readFileDownload(f.ctx, 'session', f.id, signal()), {
      attachmentId: f.id,
      bytes: bytes.length,
      data: bytes.toString('base64'),
    })
    const route = mounted(f, FILE_DOWNLOAD_ROUTE)
    const response = await route.fetch()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json()).data, bytes.toString('base64'))
    route.dispose()
  }
  const f = fixture()
  f.ref.bytes = FILE_DOWNLOAD_BYTES + 1
  await assert.rejects(readFileDownload(f.ctx, 'session', f.id, signal()), {
    code: 'FILE_TOO_LARGE',
  })
  f.events.length = 0
  await assert.rejects(readFileDownload(f.ctx, 'session', f.id, signal()), {
    code: 'ATTACHMENT_NOT_REFERENCED',
  })
  assert.equal(f.reads(), 0)
})

test('original downloads reject corrupt provider bytes before returning a response', async () => {
  const f = fixture(Buffer.from('abc'))
  f.ctx.attachments.readFileStream = async function* () {
    yield Buffer.from('abd')
  }
  const route = mounted(f, FILE_DOWNLOAD_ROUTE)
  const response = await route.fetch()
  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'INVALID_ATTACHMENT' })
  route.dispose()
})

test('file previews preserve literal Unicode text and empty files without host paths', async () => {
  for (const bytes of [Buffer.from('中文 <script>alert(1)</script>\n'), Buffer.alloc(0)]) {
    const f = fixture(bytes)
    assert.deepEqual(await read(f), {
      attachmentId: f.id,
      bytes: bytes.length,
      text: bytes.toString(),
    })
    assert.equal(f.reads(), 1)
  }
})

test('file authorization requires an exact durable reference in a recognized message', async () => {
  for (const type of ['user/message', 'assistant/message', 'tool/result']) {
    const f = fixture()
    const message = f.events[0].data
    f.events[0] = { type, data: type === 'user/message' ? message : { message } }
    assert.equal((await read(f)).attachmentId, f.id)
  }
  for (const change of [
    (f) => {
      f.events[0].type = 'arbitrary'
    },
    (f) => {
      f.events[0].data.content[0].type = 'image'
    },
    (f) => {
      f.events[0].data.content = 'invalid'
    },
    (f) => {
      f.ref.attachmentId = `sha256:${'0'.repeat(64)}`
    },
  ]) {
    const f = fixture()
    change(f)
    await assert.rejects(read(f), { code: 'ATTACHMENT_NOT_REFERENCED' })
    assert.equal(f.reads(), 0)
  }
})

test('file preview validates identity and size before invoking attachment storage', async () => {
  const f = fixture()
  for (const [session, id] of [
    ['', f.id],
    ['x'.repeat(513), f.id],
    ['session', '../secret'],
  ]) {
    await assert.rejects(readFilePreview(f.ctx, session, id, signal()), {
      code: 'INVALID_IDENTITY',
    })
  }
  for (const bytes of [-1, 1.5, undefined, FILE_PREVIEW_BYTES + 1]) {
    f.ref.bytes = bytes
    await assert.rejects(read(f), {
      code: bytes > FILE_PREVIEW_BYTES ? 'FILE_TOO_LARGE' : 'INVALID_ATTACHMENT',
    })
  }
  assert.equal(f.reads(), 0)
})

test('preview rejects corrupt, truncated, oversized and non-byte provider streams', async () => {
  for (const chunks of [[Buffer.from('x')], [Buffer.alloc(200)], ['bad'], []]) {
    const f = fixture()
    f.ctx.attachments.readFileStream = async function* () {
      yield* chunks
    }
    await assert.rejects(read(f), { code: 'INVALID_ATTACHMENT' })
  }
  const f = fixture()
  f.ctx.attachments.readFileStream = async function* () {
    yield Buffer.alloc(f.ref.bytes, 'x')
  }
  await assert.rejects(read(f), { code: 'INVALID_ATTACHMENT' })
})

test('file previews refuse binary controls and invalid UTF-8 but accept exact size limit', async () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from('binary\0data'), Buffer.from([0x7f])]) {
    await assert.rejects(read(fixture(bytes)), { code: 'UNSUPPORTED_ENCODING' })
  }
  assert.equal(
    (await read(fixture(Buffer.alloc(FILE_PREVIEW_BYTES, 'a')))).bytes,
    FILE_PREVIEW_BYTES,
  )
})

test('cancellation prevents reads and never publishes partial bytes', async () => {
  const f = fixture(),
    controller = new AbortController()
  controller.abort()
  await assert.rejects(readFilePreview(f.ctx, 'session', f.id, controller.signal), {
    name: 'AbortError',
  })
  assert.equal(f.reads(), 0)
  const next = new AbortController()
  f.ctx.attachments.readFileStream = async function* () {
    yield f.data
    next.abort()
  }
  await assert.rejects(readFilePreview(f.ctx, 'session', f.id, next.signal), { name: 'AbortError' })
})

function mounted(f, path = FILE_PREVIEW_ROUTE) {
  let route, dispose
  registerFilePreview({
    ...f.ctx,
    connection: {
      fetch: {
        register: (value) => {
          if (value.path === path) route = value
        },
      },
    },
    effect: (setup) => {
      dispose = setup()
    },
  })
  assert.equal(route.path, path)
  assert.deepEqual(route.methods, ['GET'])
  const fetch = (query = `sessionId=session&attachmentId=${f.id}`) =>
    route.fetch(new Request(`http://localhost${route.path}?${query}`))
  return { fetch, dispose }
}

test('authenticated route returns no-store JSON and rejects extra or ambiguous query fields', async () => {
  const f = fixture(),
    h = mounted(f)
  const response = await h.fetch()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(await response.json(), await read(f))
  for (const query of [
    '',
    `sessionId=session&attachmentId=${f.id}&path=secret`,
    `sessionId=session&sessionId=other&attachmentId=${f.id}`,
  ]) {
    assert.equal((await h.fetch(query)).status, 400)
  }
  h.dispose()
  assert.equal((await h.fetch()).status, 503)
})

test('route hides private provider errors and caps simultaneous requests', async () => {
  const f = fixture()
  f.ctx.sessionQuery.observeSession = async () => {
    throw Error('C:/private/secret')
  }
  const h = mounted(f)
  const rejected = await h.fetch()
  assert.equal(rejected.status, 503)
  assert.deepEqual(await rejected.json(), { error: 'UNAVAILABLE' })
  const releases = []
  f.ctx.sessionQuery.observeSession = () =>
    new Promise((resolve) =>
      releases.push(() => resolve({ events: f.events, [Symbol.dispose]() {} })),
    )
  const pending = Array.from({ length: 4 }, () => h.fetch())
  assert.equal((await h.fetch()).status, 429)
  h.dispose()
  releases.forEach((release) => release())
  assert((await Promise.all(pending)).every((response) => response.status === 503))
})

test('route timeout cancels observation and frees its bounded request slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  let cancelled = false
  f.ctx.sessionQuery.observeSession = (_, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          cancelled = true
          reject(signal.reason)
        },
        { once: true },
      )
    })
  const h = mounted(f)
  const pending = h.fetch()
  t.mock.timers.tick(20_000)
  assert.equal((await pending).status, 503)
  assert(cancelled)
  f.ctx.sessionQuery.observeSession = async () => ({ events: f.events, [Symbol.dispose]() {} })
  assert.equal((await h.fetch()).status, 200)
  h.dispose()
})

test('authorization always releases its observation lease on success and denial', async () => {
  const f = fixture()
  let disposed = 0
  f.ctx.sessionQuery.observeSession = async () => ({
    events: f.events,
    [Symbol.dispose]() {
      disposed++
    },
  })
  await read(f)
  assert.equal(disposed, 1)
  f.events.length = 0
  await assert.rejects(read(f), { code: 'ATTACHMENT_NOT_REFERENCED' })
  assert.equal(disposed, 2)
})

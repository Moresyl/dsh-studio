import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(
  'src-tauri/runtime-contract/dsh-studio-integration/lib/client.js',
  'utf8',
)
const attachmentId = `sha256:${'a'.repeat(64)}`
function mount(read, fetch) {
  const messages = [],
    effects = [],
    listeners = new Set()
  const parent = { postMessage: (data, origin) => messages.push({ data, origin }) }
  let plugin
  const window = {
    parent,
    dshStudio: { workspace: { onDrop: () => () => {} } },
    __ModuleLoader__: {
      load: (module) => {
        plugin = module.factory()
      },
    },
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
  }
  const document = {
    createElement: () => ({ remove() {} }),
    head: { append() {} },
    body: { dataset: {}, hasAttribute: () => false, toggleAttribute() {} },
    documentElement: { style: {} },
  }
  runInNewContext(source, {
    window,
    document,
    Symbol,
    fetch,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
  })
  plugin.apply({
    inject: (names, setup) => {
      assert.equal(JSON.stringify(names), JSON.stringify(['remote', 'remote.session']))
      if (read)
        setup({
          remote: { session: { attachment: read } },
          effect: (setup) => effects.push(setup()),
        })
    },
    effect: (setup) => effects.push(setup()),
  })
  const send = async (patch = {}, from = parent) => {
    await Promise.all(
      [...listeners].map((fn) =>
        fn({
          source: from,
          origin: 'http://127.0.0.1:4567',
          data: {
            type: 'dsh-studio:image-read',
            id: 'request',
            sessionId: 'session',
            attachmentId,
            ...patch,
          },
        }),
      ),
    )
  }
  return { send, messages, dispose: () => effects.forEach((fn) => fn()) }
}

test('image bridge calls only the session-authorized API and targets the initiating parent origin', async () => {
  const calls = []
  const value = { attachment: { attachmentId }, data: 'YWJj' }
  const h = mount(async (request) => {
    calls.push(request)
    return { ok: true, value }
  })
  await h.send({}, {})
  await h.send({ attachmentId: '../../secret' })
  await h.send({ sessionId: '' })
  await h.send({ id: 'x'.repeat(65) })
  assert.equal(calls.length, 0)
  await h.send()
  assert.equal(JSON.stringify(calls), JSON.stringify([{ sessionId: 'session', attachmentId }]))
  assert.equal(h.messages.at(-1).origin, 'http://127.0.0.1:4567')
  assert.equal(h.messages.at(-1).data.ok, true)
  assert.equal(h.messages.at(-1).data.value, value)
  h.dispose()
})

test('missing API, denied, malformed and oversized reads return no backend details', async () => {
  for (const read of [
    undefined,
    async () => ({ ok: false, error: { message: 'private' } }),
    async () => {
      throw Error('private')
    },
    async () => ({ ok: true, value: {} }),
    async () => ({ ok: true, value: { data: 'x'.repeat(27962029) } }),
  ]) {
    const h = mount(read)
    await h.send()
    assert.equal(h.messages.at(-1).data.ok, false)
    assert(!JSON.stringify(h.messages).includes('private'))
    h.dispose()
  }
})

test('pending reads are bounded and disposed clients never send late image bytes', async () => {
  const finish = []
  const h = mount(() => new Promise((resolve) => finish.push(resolve)))
  const waiting = Array.from({ length: 4 }, (_, n) => h.send({ id: String(n) }))
  await h.send({ id: 'excess' })
  assert.equal(finish.length, 4)
  assert.equal(h.messages.at(-1).data.ok, false)
  h.dispose()
  const before = h.messages.length
  finish.forEach((resolve) => resolve({ ok: true, value: { data: 'YWJj' } }))
  await Promise.all(waiting)
  assert.equal(h.messages.length, before)
})

test('file previews use one same-origin authenticated route and abort on disposal', async () => {
  const calls = []
  const value = { attachmentId, bytes: 3, text: 'abc' }
  const h = mount(undefined, async (url, options) => {
    calls.push({ url, options })
    return { ok: true, json: async () => value }
  })
  await h.send({ kind: 'file' })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url, 'http://localhost')
  assert.equal(url.pathname, '/api/studio/file-preview')
  assert.equal(url.searchParams.get('sessionId'), 'session')
  assert.equal(calls[0].options.credentials, 'same-origin')
  assert.equal(h.messages.at(-1).data.value, value)
  await h.send({ kind: 'unknown' })
  assert.equal(calls.length, 1)
  h.dispose()
  let aborted = false
  const waiting = mount(
    undefined,
    (_, options) =>
      new Promise((_, reject) =>
        options.signal.addEventListener('abort', () => {
          aborted = true
          reject(Error('stopped'))
        }),
      ),
  )
  const pending = waiting.send({ kind: 'file' })
  waiting.dispose()
  await pending
  assert(aborted)
})

test('file bridge rejects denied and oversized text without forwarding backend errors', async () => {
  for (const response of [
    { ok: false },
    { ok: true, json: async () => ({ text: 'x'.repeat(1048577) }) },
  ]) {
    const h = mount(undefined, async () => response)
    await h.send({ kind: 'file' })
    assert.equal(h.messages.at(-1).data.ok, false)
    h.dispose()
  }
})

test('only the initiating parent can cancel its pending file request', async () => {
  let aborted = false
  const h = mount(
    undefined,
    (_, options) =>
      new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true
          reject(Error('cancelled'))
        })
      }),
  )
  const pending = h.send({ kind: 'file' })
  await h.send({ type: 'dsh-studio:preview-cancel' }, {})
  assert(!aborted)
  await h.send({ type: 'dsh-studio:preview-cancel' })
  await pending
  assert(aborted)
  h.dispose()
})

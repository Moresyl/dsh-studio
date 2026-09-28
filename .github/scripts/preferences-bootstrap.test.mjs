import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(
  new URL('../../src-tauri/src/preferences-bootstrap.js', import.meta.url),
  'utf8',
)
const origin = 'http://127.0.0.1:1234'
function mount(
  values,
  { storage = new Map(), boot = 'one', framed = false, pageOrigin = origin, disabled = false } = {},
) {
  const window = {}
  window.top = window
  window.self = framed ? {} : window
  const localStorage = {
    getItem: (key) => {
      if (disabled) throw new Error('storage disabled')
      return storage.get(key) ?? null
    },
    setItem: (key, value) => {
      storage.set(key, value)
    },
  }
  runInNewContext(
    `(${source})(${JSON.stringify(origin)}, ${JSON.stringify(values)}, ${JSON.stringify(boot)})`,
    { window, location: { origin: pageOrigin }, localStorage },
  )
  return { window, storage }
}

test('first load seeds native values but reload and sibling window preserve newer choices', () => {
  const storage = new Map()
  mount({ 'dsh-studio.theme': 'dark' }, { storage })
  assert.equal(storage.get('dsh-studio.theme'), 'dark')
  storage.set('dsh-studio.theme', 'light')
  mount({ 'dsh-studio.theme': 'dark' }, { storage })
  assert.equal(storage.get('dsh-studio.theme'), 'light')
  mount({ 'dsh-studio.theme': 'dark', 'dsh-studio.sidebar': 'collapsed' }, { storage })
  assert.equal(storage.get('dsh-studio.theme'), 'light')
})

test('a new process refreshes reused-origin storage from its new native snapshot', () => {
  const storage = new Map()
  mount({ 'dsh-studio.theme': 'dark' }, { storage, boot: 'old' })
  mount({ 'dsh-studio.theme': 'light' }, { storage, boot: 'new' })
  assert.equal(storage.get('dsh-studio.theme'), 'light')
})

test('disabled storage keeps the bounded native snapshot readable', () => {
  const { window } = mount({ 'dsh-studio.theme': 'light' }, { disabled: true })
  assert.equal(window.__DSH_SAVED_PREFERENCES__['dsh-studio.theme'], 'light')
})

test('a child frame or another origin never receives preferences', () => {
  for (const options of [{ framed: true }, { pageOrigin: 'http://127.0.0.1:12345' }]) {
    const { window, storage } = mount({ 'dsh-studio.theme': 'light' }, options)
    assert.equal(window.__DSH_SAVED_PREFERENCES__, undefined)
    assert.equal(storage.size, 0)
  }
})

test('serialized preference text remains data rather than executable source', () => {
  const value = '"); window.compromised = true; //'
  const { window, storage } = mount({ 'dsh-studio:usage:rates:v1': value })
  assert.equal(window.compromised, undefined)
  assert.equal(storage.get('dsh-studio:usage:rates:v1'), value)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(
  join('src-tauri', 'runtime-contract', 'dsh-studio-integration', 'lib', 'client.js'),
  'utf8',
)

function mount({ desktop = true, framed = true } = {}) {
  const effects = []
  const listeners = new Map()
  const styles = []
  const parentMessages = []
  const parent = { postMessage: (message) => parentMessages.push(message) }
  const attributes = new Set()
  const body = {
    dataset: {},
    hasAttribute: (name) => attributes.has(name),
    toggleAttribute: (name, enabled) => {
      if (enabled) attributes.add(name)
      else attributes.delete(name)
    },
  }
  const document = {
    body,
    head: { append: (style) => styles.push(style) },
    documentElement: { style: {} },
    createElement: () => ({
      textContent: '',
      remove() {
        styles.splice(styles.indexOf(this), 1)
      },
    }),
  }
  const window = {
    parent: framed ? parent : null,
    dshStudio: desktop ? { workspace: { onDrop: () => () => {} } } : undefined,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (listeners.get(name) === listener) listeners.delete(name)
    },
  }
  if (!framed) window.parent = window
  let module
  window.__ModuleLoader__ = {
    load: (definition) => {
      module = definition.factory()
    },
  }
  runInNewContext(source, { window, document, Symbol })
  module.apply({ effect: (cleanup) => effects.push(cleanup) })
  return { attributes, body, document, effects, listeners, parent, parentMessages, styles }
}

test('managed Harness receives only parent light and dark themes', () => {
  const harness = mount()
  assert.equal(harness.styles.length, 1)
  assert.match(harness.styles[0].textContent, /--dsw-alias-bg-base: #212121 !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-bg-layer-1: #181818 !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-border-l1: #ffffff1a !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-label-secondary: #afafaf !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-bg-base: #ffffff !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-bg-layer-1: #f9f9f9 !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-border-l1: #00000014 !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-label-primary: #282828 !important/)
  assert.match(harness.styles[0].textContent, /OpenAI Sans/)
  assert.match(harness.styles[0].textContent, /-apple-system-body/)
  assert.equal(harness.parentMessages.length, 1)
  assert.equal(harness.parentMessages[0].type, 'dsh-studio:theme-ready')

  const message = harness.listeners.get('message')
  message({ source: {}, data: { type: 'dsh-studio:theme', theme: 'dark' } })
  message({ source: harness.parent, data: { type: 'dsh-studio:theme', theme: 'invalid' } })
  assert.equal(harness.body.dataset.dshStudioTheme, undefined)

  message({ source: harness.parent, data: { type: 'dsh-studio:theme', theme: 'dark' } })
  assert.equal(harness.body.dataset.dshStudioTheme, 'dark')
  assert.equal(harness.document.documentElement.style.colorScheme, 'dark')
  assert.equal(harness.attributes.has('data-ds-dark-theme'), true)

  message({ source: harness.parent, data: { type: 'dsh-studio:theme', theme: 'light' } })
  assert.equal(harness.body.dataset.dshStudioTheme, 'light')
  assert.equal(harness.attributes.has('data-ds-dark-theme'), false)

  harness.effects.forEach((cleanup) => cleanup())
  assert.equal(harness.listeners.has('message'), false)
  assert.equal(harness.styles.length, 0)
  assert.equal(harness.body.dataset.dshStudioTheme, undefined)
  assert.equal(harness.attributes.has('data-ds-dark-theme'), false)
  assert.equal(harness.document.documentElement.style.colorScheme, undefined)
})

test('ordinary browser and top-level Harness get no Studio theme override', () => {
  for (const options of [{ desktop: false }, { framed: false }]) {
    const harness = mount(options)
    assert.equal(harness.styles.length, 0)
    assert.equal(harness.listeners.has('message'), false)
    assert.equal(harness.parentMessages.length, 0)
  }
})

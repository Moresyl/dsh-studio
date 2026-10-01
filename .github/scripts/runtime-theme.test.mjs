import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(
  join('src-tauri', 'runtime-contract', 'dsh-studio-integration', 'lib', 'client.js'),
  'utf8',
)

/**
 * Harness's own theme service, reduced to the members the bridge touches.
 * `pickInHarness` is the Appearance row in Harness's settings: it reaches the same
 * entry point the window's choice does, which is the whole reason for the bridge.
 */
function fakeTheme(preference = 'light', { systemDark = false } = {}) {
  const handlers = new Set()
  const resolve = (value) => (value === 'system' ? (systemDark ? 'dark' : 'light') : value)
  let snapshot = { preference, active: { colorScheme: resolve(preference) } }
  const calls = []
  const publish = (next) => {
    snapshot = { preference: next, active: { colorScheme: resolve(next) } }
    for (const handler of handlers) handler(snapshot)
  }
  return {
    calls,
    getTheme: () => snapshot,
    setTheme: (next) => {
      calls.push(next)
      publish(next)
    },
    pickInHarness: publish,
    on: (name, handler) => {
      assert.equal(name, 'theme/change')
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}

function mount({ desktop = true, framed = true, theme = null } = {}) {
  // Time the test moves by hand: the bridge waits for a value to hold still, and
  // for Harness's saved settings to catch up with what it was just told.
  const clock = { now: 1_000_000 }
  const advance = (ms) => {
    clock.now += ms
  }
  const timers = []
  const fakeSetTimeout = (run) => timers.push({ run, live: true })
  const fakeClearTimeout = (id) => {
    if (timers[id - 1]) timers[id - 1].live = false
  }
  const flush = () => {
    for (const timer of timers.splice(0)) if (timer.live) timer.run()
  }
  const effects = []
  const listeners = new Map()
  const styles = []
  const parentMessages = []
  const parentOrigins = []
  const parent = {
    postMessage: (message, origin) => {
      parentMessages.push(message)
      parentOrigins.push(origin)
    },
  }
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
  runInNewContext(source, {
    window,
    document,
    Symbol,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Date: { now: () => clock.now },
  })
  module.apply({
    inject: (names, setup) => {
      if (theme !== null && JSON.stringify(names) === JSON.stringify(['theme'])) {
        setup({ theme, on: theme.on, effect: (run) => effects.push(run()) })
      }
    },
    effect: (setup) => effects.push(setup()),
  })
  return {
    advance,
    attributes,
    body,
    document,
    effects,
    flush,
    listeners,
    parent,
    parentMessages,
    parentOrigins,
    styles,
  }
}

test('managed Harness receives only parent light and dark themes', () => {
  const harness = mount()
  assert.equal(harness.styles.length, 1)
  assert.match(harness.styles[0].textContent, /--dsw-alias-bg-base: #212121 !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-bg-layer-1: #181818 !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-border-l1: #ffffff1a !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-label-secondary: #afafaf !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-label-tertiary: #999999 !important/)
  assert.match(harness.styles[0].textContent, /--dsw-alias-label-tertiary: #6b6b6b !important/)
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

const ORIGIN = 'tauri://localhost'
const ask = (harness, theme, preference) =>
  harness.listeners.get('message')({
    source: harness.parent,
    origin: ORIGIN,
    data: { type: 'dsh-studio:theme', theme, preference },
  })

test("with Harness's theme service the window's choice goes through it and the document is left to Harness", () => {
  const service = fakeTheme('light')
  const harness = mount({ theme: service })

  // The palette follows what Harness is drawing before the window has said anything.
  assert.equal(harness.body.dataset.dshStudioTheme, 'light')

  ask(harness, 'dark', 'system')
  assert.deepEqual(service.calls, ['system'])
  assert.equal(harness.body.dataset.dshStudioTheme, 'light')

  ask(harness, 'dark', 'dark')
  assert.deepEqual(service.calls, ['system', 'dark'])
  assert.equal(harness.body.dataset.dshStudioTheme, 'dark')

  // The presenter owns these two; the bridge must not write them itself.
  assert.equal(harness.attributes.has('data-ds-dark-theme'), false)
  assert.equal(harness.document.documentElement.style.colorScheme, undefined)

  // Saying the same thing twice is not a change.
  ask(harness, 'dark', 'dark')
  assert.deepEqual(service.calls, ['system', 'dark'])
})

test('the palette follows the scheme Harness draws even when its own row changes it', () => {
  const service = fakeTheme('light')
  const harness = mount({ theme: service })
  ask(harness, 'light', 'light')
  harness.advance(SETTLED)

  service.pickInHarness('dark')
  assert.equal(harness.body.dataset.dshStudioTheme, 'dark')
  service.pickInHarness('light')
  assert.equal(harness.body.dataset.dshStudioTheme, 'light')
})

test("a choice made in Harness's Appearance row is reported to the window exactly once", () => {
  const service = fakeTheme('light')
  const harness = mount({ theme: service })
  ask(harness, 'light', 'light')
  assert.equal(harness.parentMessages.length, 1) // only the ready signal so far
  harness.advance(SETTLED)

  service.pickInHarness('dark')
  assert.equal(harness.parentMessages.length, 1) // not yet: it has to hold still first
  harness.flush()
  assert.equal(harness.parentMessages.length, 2)
  // Compared field by field: the message was built in the plugin's own context.
  assert.equal(harness.parentMessages[1].type, 'dsh-studio:theme-preference')
  assert.equal(harness.parentMessages[1].preference, 'dark')
  // Addressed to the window that spoke, not to whoever happens to be listening.
  assert.equal(harness.parentOrigins[1], ORIGIN)

  // The window adopts it and says so; hearing its own answer back changes nothing.
  ask(harness, 'dark', 'dark')
  assert.deepEqual(service.calls, [])
  assert.equal(harness.parentMessages.length, 2)
})

// Longer than the bridge waits for Harness's saved settings to catch up.
const SETTLED = 3500

test('successive choices after initial loading are never hidden by a new settling window', () => {
  const service = fakeTheme('light')
  const harness = mount({ theme: service })
  ask(harness, 'light', 'light')
  harness.advance(SETTLED)
  ask(harness, 'dark', 'dark')
  service.pickInHarness('system')
  harness.flush()
  assert.equal(service.getTheme().preference, 'system')
  assert.equal(harness.parentMessages.at(-1).preference, 'system')
  ask(harness, 'system', 'light')
  service.pickInHarness('light')
  harness.flush()
  assert.equal(harness.parentMessages.at(-1).preference, 'light')
})

test('Harness does not speak before the window has said what it wants', () => {
  const service = fakeTheme('light')
  const harness = mount({ theme: service })

  // Its saved preference is whatever it was last time. If that were reported it
  // would overrule the window the user is actually looking at.
  service.pickInHarness('dark')
  assert.equal(harness.parentMessages.length, 1)
  assert.equal(harness.parentMessages[0].type, 'dsh-studio:theme-ready')
  assert.equal(harness.body.dataset.dshStudioTheme, 'dark')
})

test('a window that only names a scheme is obeyed as an explicit preference', () => {
  const service = fakeTheme('system', { systemDark: true })
  const harness = mount({ theme: service })
  harness.listeners.get('message')({
    source: harness.parent,
    data: { type: 'dsh-studio:theme', theme: 'light' },
  })
  assert.deepEqual(service.calls, ['light'])
})

test("tearing the bridge down leaves the presenter's attributes alone", () => {
  const service = fakeTheme('light')
  const harness = mount({ theme: service })
  ask(harness, 'dark', 'dark')
  harness.attributes.add('data-ds-dark-theme') // what Harness's presenter wrote

  harness.effects.forEach((cleanup) => cleanup?.())
  assert.equal(harness.listeners.has('message'), false)
  assert.equal(harness.body.dataset.dshStudioTheme, undefined)
  assert.equal(harness.attributes.has('data-ds-dark-theme'), true)
})

test("the window's choice stands while Harness's saved settings catch up", () => {
  const service = fakeTheme('system')
  const harness = mount({ theme: service })
  ask(harness, 'dark', 'dark')
  assert.deepEqual(service.calls, ['dark'])

  // What a real Harness does after setTheme('dark'): it adopts the old saved value,
  // and only then is the new one confirmed. The middle value is nobody's choice, so
  // it is put right, not reported.
  service.pickInHarness('system')
  service.pickInHarness('dark')
  harness.flush()

  assert.deepEqual(service.calls, ['dark', 'dark'])
  assert.equal(service.getTheme().preference, 'dark')
  assert.equal(harness.parentMessages.length, 1)
  assert.equal(harness.parentMessages[0].type, 'dsh-studio:theme-ready')
})

test('a saved value that disagrees is not reported however long it lingers inside the window', () => {
  const service = fakeTheme('light')
  const harness = mount({ theme: service })
  ask(harness, 'light', 'light')

  service.pickInHarness('dark') // last run's saved value, arriving late
  harness.advance(2000)
  harness.flush()
  assert.equal(service.getTheme().preference, 'light')
  assert.equal(harness.parentMessages.length, 1)
})

test('a value that does not hold still is not reported either', () => {
  const service = fakeTheme('dark')
  const harness = mount({ theme: service })
  ask(harness, 'dark', 'dark')
  harness.advance(SETTLED)

  service.pickInHarness('light')
  // ...and the window answers before it is reported
  ask(harness, 'light', 'light')
  harness.flush()
  assert.equal(harness.parentMessages.length, 1)
})

test('tearing down cancels a report that was waiting', () => {
  const service = fakeTheme('dark')
  const harness = mount({ theme: service })
  ask(harness, 'dark', 'dark')
  harness.advance(SETTLED)
  service.pickInHarness('light')

  harness.effects.forEach((cleanup) => cleanup?.())
  harness.flush()
  assert.equal(harness.parentMessages.length, 1)
})

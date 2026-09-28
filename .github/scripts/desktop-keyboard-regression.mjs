// Local real-WebView acceptance: native CDP key dispatch, no bridge mocks.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const [qaHome, output, port = '9223'] = process.argv.slice(2)
assert(qaHome && output, 'QA_HOME OUTPUT [PORT] required')
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
assert.equal(targets.filter((t) => t.type === 'page').length, 1, 'one isolated QA window required')
const socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let serial = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const value = JSON.parse(event.data)
  const entry = pending.get(value.id)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(value.id)
  if (value.error) entry.reject(new Error(value.error.message))
  else entry.resolve(value.result)
})
const command = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, 20000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description)
  return result.result.value
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(expression) {
  const end = Date.now() + 10000
  do {
    if (await evaluate(`Boolean(${expression})`)) return
    await pause(30)
  } while (Date.now() < end)
  throw new Error(`UI timeout: ${expression}`)
}
async function key(key, windowsVirtualKeyCode, modifiers = 0, code = key) {
  for (const type of ['keyDown', 'keyUp'])
    await command('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers })
}
const normalize = (value) => resolve(value).replaceAll('\\', '/').toLowerCase()
const identity = await evaluate(`(async()=>({
  profile:(await window.__TAURI_INTERNALS__.invoke('plugin_state')).profileDir,
  status:await window.__TAURI_INTERNALS__.invoke('harness_status'),
  label:window.__TAURI_INTERNALS__.metadata.currentWindow.label,
}))()`)
assert(normalize(identity.profile).startsWith(`${normalize(qaHome)}/profiles/`), 'not isolated QA')
assert.equal(identity.label, 'main')
const selectors = []
const checks = []
try {
  await command('Runtime.enable')
  for (const route of ['运行状态', '终端', '会话', '插件', '远程', '关于', '设置']) {
    await evaluate(
      `(()=>{const b=[...document.querySelectorAll('aside button')].find(b=>b.innerText.trim().split('\\n')[0]===${JSON.stringify(route)});if(!b)throw Error('route missing');b.focus();b.click();return true})()`,
    )
    await wait(
      `document.querySelector('aside [aria-current="page"]')?.innerText.trim().split('\\n')[0]===${JSON.stringify(route)}`,
    )
    await wait(
      `[...document.querySelectorAll('h1,h2')].some(h=>h.getClientRects().length&&h.innerText.trim()===${JSON.stringify(route === '插件' ? '插件市场' : route === '远程' ? '远程访问' : route)})`,
    )
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))')
    if (route === '插件')
      await wait(
        `document.querySelectorAll('button.select-control__trigger:not(:disabled)').length>=3`,
      )
    if (route === '设置')
      await wait(
        `document.querySelectorAll('button.select-control__trigger:not(:disabled)').length>=2`,
      )
    const count = await evaluate(
      `document.querySelectorAll('button.select-control__trigger:not(:disabled)').length`,
    )
    for (let index = 0; index < count; index++) {
      const trigger = `document.querySelectorAll('button.select-control__trigger:not(:disabled)')[${index}]`
      const before = await evaluate(
        `(()=>{const b=${trigger};b.scrollIntoView({block:'nearest'});b.focus();return {label:b.getAttribute('aria-label'),value:b.innerText}})()`,
      )
      await key('ArrowDown', 40)
      await wait(
        `document.querySelector('[role=menu]') && ${trigger}.getAttribute('aria-expanded')==='true'`,
      )
      await pause(180)
      const state = await evaluate(
        `(()=>{const m=document.querySelector('[role=menu]'),r=m.getBoundingClientRect();return {items:[...m.querySelectorAll('button:not(:disabled)')].map(b=>b.id),selected:m.querySelectorAll('[aria-checked=true]').length,focused:document.activeElement===m,within:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,controls:${trigger}.getAttribute('aria-controls')===m.id}})()`,
      )
      assert(state.focused && state.controls, `${route}/${before.label}: focus or owner`)
      assert(state.within, `${route}/${before.label}: menu outside viewport`)
      assert(state.items.length > 0, `${route}/${before.label}: empty options`)
      assert.equal(state.selected, 1, `${route}/${before.label}: selected item count`)
      for (const [name, number, target] of [
        ['End', 35, state.items.at(-1)],
        ['Home', 36, state.items[0]],
        ['ArrowUp', 38, state.items.at(-1)],
        ['ArrowDown', 40, state.items[0]],
      ]) {
        await key(name, number)
        await wait(
          `document.querySelector('[role=menu]')?.getAttribute('aria-activedescendant')===${JSON.stringify(target)}`,
        )
        assert(
          await evaluate(
            `(()=>{const m=document.querySelector('[role=menu]'),r=m.getBoundingClientRect(),i=document.getElementById(${JSON.stringify(target)}).getBoundingClientRect();return i.top>=r.top&&i.bottom<=r.bottom})()`,
          ),
          `${route}/${before.label}: active item outside visible menu after ${name}`,
        )
      }
      await key('Escape', 27)
      await wait(`!document.querySelector('[role=menu]') && document.activeElement===${trigger}`)
      assert.equal(await evaluate(`${trigger}.innerText`), before.value, 'Escape changed selection')
      assert.equal(await evaluate(`${trigger}.getAttribute('aria-expanded')`), 'false')
      await key('ArrowUp', 38)
      await wait(`document.querySelector('[role=menu]')`)
      await key('Tab', 9)
      await wait(`!document.querySelector('[role=menu]')`)
      assert.equal(await evaluate(`${trigger}.innerText`), before.value, 'Tab changed selection')
      selectors.push({ route, ...before, options: state.items.length })
    }
    assert.equal(
      await evaluate('document.documentElement.scrollWidth>innerWidth'),
      false,
      `${route}: overflow`,
    )
  }
  assert(selectors.length >= 5, 'too few live selectors exercised')
  checks.push(
    'all visible enabled selectors: real Arrow/Home/End wrap, Escape focus restoration, Tab dismissal, no selection mutation, menu viewport bounds',
  )
  await evaluate(`document.querySelector('aside [aria-current="page"]').focus()`)
  await key('k', 75, 2, 'KeyK')
  await wait(
    `document.querySelector('[role=dialog] input[role=combobox]')===document.activeElement`,
  )
  const first = await evaluate(`document.activeElement.getAttribute('aria-activedescendant')`)
  assert(first)
  await key('ArrowDown', 40)
  await wait(
    `document.activeElement.getAttribute('aria-activedescendant')!==${JSON.stringify(first)}`,
  )
  await key('Escape', 27)
  await wait(`!document.querySelector('[role=dialog]')`)
  assert.equal(
    await evaluate(
      `document.activeElement===document.querySelector('aside [aria-current="page"]')`,
    ),
    true,
    'palette opener focus',
  )
  checks.push('Ctrl+K palette: input focus, selection navigation, Escape restores opener')
  const status = await evaluate(`window.__TAURI_INTERNALS__.invoke('harness_status')`)
  assert.equal(status.phase, identity.status.phase)
  assert.equal(status.pid, identity.status.pid)
  await mkdir(resolve(output), { recursive: true })
  const result = { selectors, checks, completed: new Date().toISOString() }
  await writeFile(join(resolve(output), 'keyboard.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await key('Escape', 27).catch(() => {})
  socket.close()
}

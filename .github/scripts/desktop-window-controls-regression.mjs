// Hit-tested WebView input and actual native window state; QA data only.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const [qaHome, output, port = '9223'] = process.argv.slice(2)
const quit = process.argv[5] === 'quit'
assert(qaHome && output, 'QA_HOME OUTPUT [PORT] required')
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
assert.equal(targets.filter((t) => t.type === 'page').length, 1, 'one QA window required')
const socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
await new Promise((accept, reject) => {
  socket.addEventListener('open', accept, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let serial = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const reply = JSON.parse(event.data)
  const request = pending.get(reply.id)
  if (!request) return
  clearTimeout(request.timer)
  pending.delete(reply.id)
  if (reply.error) request.reject(new Error(reply.error.message))
  else request.accept(reply.result)
})
function command(method, params = {}) {
  return new Promise((accept, reject) => {
    const id = ++serial
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${method}`))
    }, 20000)
    pending.set(id, { accept, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
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
const invoke = (name, args = {}) =>
  evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`)
const native = (name) => invoke(`plugin:window|${name}`, { label: 'main' })
async function wait(expression, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(`(async()=>Boolean(await (${expression})))()`)) return
    await new Promise((accept) => setTimeout(accept, 50))
  }
  throw new Error(`UI timeout: ${expression}`)
}
async function pointer(selector) {
  const point = await evaluate(`(() => {
    const b=${selector}; if(!b||b.disabled)throw new Error('missing enabled action');
    const r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    if(!b.contains(document.elementFromPoint(x,y)))throw new Error('action is covered');
    return {x,y};
  })()`)
  for (const type of ['mousePressed', 'mouseReleased'])
    await command('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
}
const byText = (text, scope = 'document') =>
  `[...${scope}.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.innerText.trim()===${JSON.stringify(text)})`
const control = (index) => `document.querySelectorAll('[data-window-controls] button')[${index}]`
const normalize = (value) => resolve(value).replaceAll('\\', '/').toLowerCase()
const profile = await invoke('plugin_state')
assert(
  normalize(profile.profileDir).startsWith(`${normalize(qaHome)}/profiles/`),
  'not isolated QA',
)
assert.equal((await invoke('harness_status')).phase, 'stopped', 'stop QA Harness first')
assert.equal(await native('is_maximized'), false, 'restore QA window first')
await mkdir(resolve(output), { recursive: true })
const capture = async (name) => {
  const screenshot = await command('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(join(resolve(output), name), Buffer.from(screenshot.data, 'base64'))
}
async function errorDialog() {
  // A file-open notification reaches the production listener and real native
  // package reader. The missing test-owned file produces the actual error UI.
  await invoke('plugin:event|emit', {
    event: 'desktop://preset-file',
    payload: join(resolve(qaHome), `qa-missing-${Date.now()}.dshpreset`),
  })
  await wait(
    "document.querySelector('[role=alertdialog]')?.innerText.includes('preset package could not be opened')",
  )
}
const checks = []
try {
  if (await evaluate("Boolean(document.querySelector('[role=alertdialog]'))"))
    await pointer(byText('关闭', "document.querySelector('[role=alertdialog]')"))
  await pointer(byText('演示文稿', "document.querySelector('aside')"))
  await wait(`${byText('新建文稿')} && !${byText('新建文稿')}.disabled`)
  await pointer(byText('新建文稿'))
  await wait("document.querySelector('[role=dialog]')")
  await pointer(byText('创建文稿', "document.querySelector('[role=dialog]')"))
  await wait(`${byText('保存')} && !${byText('保存')}.disabled`)
  await errorDialog()
  await capture('error-controls.png')
  await pointer(control(1))
  await wait("window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized',{label:'main'})")
  assert(await evaluate("Boolean(document.querySelector('[role=alertdialog]'))"))
  await pointer(control(1))
  await wait(
    "window.__TAURI_INTERNALS__.invoke('plugin:window|is_maximized',{label:'main'}).then(v=>!v)",
  )
  await pointer(control(0))
  await wait("window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized',{label:'main'})")
  await native('unminimize')
  await wait(
    "window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized',{label:'main'}).then(v=>!v)",
  )
  checks.push(
    'real error dialog: hit-tested maximize, restore and minimize change native window state',
  )
  await pointer(control(2))
  await wait("document.querySelector('[role=alertdialog]')?.innerText.includes('放弃未保存的修改')")
  assert.equal(await native('is_visible'), true)
  await capture('unsaved-close-guard.png')
  await pointer(byText('取消', "document.querySelector('[role=alertdialog]')"))
  await wait("!document.querySelector('[role=alertdialog]')")
  assert.equal(await evaluate(`${byText('保存')}.disabled`), false)
  checks.push(
    'close remains reachable through the error overlay; unsaved draft prevents exit and Cancel preserves edits',
  )
  await pointer(byText('保存'))
  await wait(`${byText('保存')}.disabled && document.body.innerText.includes('已保存到本地')`)
  await pointer(byText('运行状态', "document.querySelector('aside')"))
  await wait(`${byText('启动 Harness')} && !${byText('启动 Harness')}.disabled`)
  await pointer(byText('启动 Harness'))
  await wait(
    "window.__TAURI_INTERNALS__.invoke('harness_status').then(s=>s.phase==='ready')",
    150000,
  )
  if (!(await evaluate("Boolean(document.querySelector('aside'))"))) {
    await pointer(byText('控制面板'))
    await wait("document.querySelector('aside')")
  }
  await pointer(byText('演示文稿', "document.querySelector('aside')"))
  await wait(`${byText('文字')}`)
  await pointer(byText('文字'))
  await wait(`!${byText('保存')}.disabled`)
  await errorDialog()
  await pointer(control(2))
  await wait(
    "window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'}).then(v=>!v)",
  )
  assert.equal((await invoke('harness_status')).phase, 'ready')
  await native('show')
  await wait("window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible',{label:'main'})")
  await pointer(byText('关闭', "document.querySelector('[role=alertdialog]')"))
  assert.equal(await evaluate(`${byText('保存')}.disabled`), false, 'tray hiding discarded draft')
  await pointer(byText('保存'))
  await wait(`${byText('保存')}.disabled && document.body.innerText.includes('已保存到本地')`)
  checks.push(
    'visible Start boots Harness; modal close hides the main window and retains the running service and unsaved draft',
  )
  await invoke('harness_stop')
  if (quit) {
    await pointer(control(2))
    const deadline = Date.now() + 20000
    while (socket.readyState !== WebSocket.CLOSED && Date.now() < deadline)
      await new Promise((accept) => setTimeout(accept, 50))
    assert.equal(socket.readyState, WebSocket.CLOSED, 'clean stopped window did not close')
    checks.push('saved stopped main window closes its real WebView without an ACL rejection')
  }
  await writeFile(
    join(resolve(output), 'window-controls.json'),
    JSON.stringify({ checks, completed: new Date().toISOString() }, null, 2),
  )
  console.log(JSON.stringify(checks, null, 2))
} finally {
  if (socket.readyState === WebSocket.OPEN) {
    await native('unminimize').catch(() => {})
    await native('show').catch(() => {})
    await invoke('harness_stop').catch(() => {})
  }
  for (const request of pending.values()) clearTimeout(request.timer)
  socket.close()
}

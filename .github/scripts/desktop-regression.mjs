// Real WebView regression runner. Requires an explicitly isolated QA profile.
// Run a single pass by default; --minutes enables a timed stability exercise.
import assert from 'node:assert/strict'
import { mkdir, appendFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const at = arg.indexOf('=')
    if (at < 0) throw new Error('arguments must use --name=value')
    return [arg.slice(2, at), arg.slice(at + 1)]
  }),
)
const port = Number(args.port ?? 9223)
const minutes = Number(args.minutes ?? 0)
const requireReady = args['require-ready'] === 'true'
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'invalid debug port')
assert(Number.isFinite(minutes) && minutes >= 0 && minutes <= 360, 'invalid duration')
assert(args['qa-home'] && args.output, '--qa-home and --output are required')
const output = resolve(args.output)
await mkdir(output, { recursive: true })
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())
const target = targets.find((item) => item.type === 'page')
assert(target?.webSocketDebuggerUrl, 'no WebView page')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((accept, reject) => {
  socket.addEventListener('open', accept, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let id = 0
const pending = new Map()
const exceptions = []
socket.addEventListener('message', (event) => {
  const reply = JSON.parse(event.data)
  if (reply.method === 'Runtime.exceptionThrown') {
    exceptions.push(reply.params.exceptionDetails.text)
  }
  const request = pending.get(reply.id)
  if (!request) return
  clearTimeout(request.timer)
  pending.delete(reply.id)
  if (reply.error) request.reject(new Error(reply.error.message))
  else request.accept(reply.result)
})
function command(method, params = {}) {
  return new Promise((accept, reject) => {
    const key = ++id
    const timer = setTimeout(() => {
      pending.delete(key)
      reject(new Error(`CDP timeout: ${method}`))
    }, 30000)
    pending.set(key, { accept, reject, timer })
    socket.send(JSON.stringify({ id: key, method, params }))
  })
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  assert(
    !result.exceptionDetails,
    result.exceptionDetails?.exception?.description ?? 'WebView evaluation failed',
  )
  return result.result.value
}
const pause = (ms) => new Promise((accept) => setTimeout(accept, ms))
async function waitFor(expression, label, timeout = 20000) {
  const end = Date.now() + timeout
  do {
    if (await evaluate(`Boolean(${expression})`)) return
    await pause(100)
  } while (Date.now() < end)
  throw new Error(`UI timeout: ${label}`)
}
async function clickText(label, scope = 'document') {
  const code = `(() => { const button = [...${scope}.querySelectorAll('button')].find(b => b.innerText.trim().split('\\n')[0] === ${JSON.stringify(label)}); if (!button || button.disabled) return false; button.focus(); button.click(); return true })()`
  assert(await evaluate(code), `missing enabled button: ${label}`)
}
async function capture(name) {
  const screenshot = await command('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(join(output, name), Buffer.from(screenshot.data, 'base64'))
}
async function key(value, code, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await command('Input.dispatchKeyEvent', {
      type,
      key: value,
      code: value,
      windowsVirtualKeyCode: code,
      modifiers,
    })
  }
}
await command('Runtime.enable')
await command('Page.enable')
await command('Performance.enable')
const actualHome = await evaluate(
  "window.__TAURI_INTERNALS__.invoke('plugin_state').then(s => s.profileDir)",
)
const normalized = (value) => value.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '')
assert(
  normalized(actualHome).startsWith(`${normalized(resolve(args['qa-home']))}/profiles/`),
  'refusing a non-QA profile',
)
// Starting Harness may select its surface; open the desktop routes explicitly.
if (!(await evaluate("Boolean(document.querySelector('aside'))"))) {
  await clickText('控制面板')
  await waitFor("document.querySelector('aside')", 'desktop navigation')
}

const started = Date.now()
const deadline = started + minutes * 60000
let pass = 0
try {
  do {
    pass += 1
    // These routes perform local reads only. Remote access is never opened;
    // terminal sessions, installs, updates and removals are not triggered.
    for (const label of ['运行状态', '终端', '会话', '插件', '远程', '关于', '设置']) {
      await clickText(label, "document.querySelector('aside')")
      await pause(250)
      const result = await evaluate(`({
        route: document.querySelector('aside [aria-current="page"]')?.innerText.trim().split('\\n')[0],
        overflow: document.documentElement.scrollWidth > innerWidth,
        dialogs: document.querySelectorAll('[role="alertdialog"], [role="dialog"]').length,
        body: document.body.innerText.length
      })`)
      assert.equal(result.route, label, `route ${label}`)
      assert(!result.overflow, `horizontal overflow: ${label}`)
      assert.equal(result.dialogs, 0, `unexpected dialog: ${label}`)
      assert(result.body > 80, `empty page: ${label}`)
    }
    await clickText('插件', "document.querySelector('aside')")
    await waitFor(
      "document.querySelector('button[aria-label*=\" · \"]') || document.body.innerText.includes('没有找到')",
      'market results',
    )
    if (pass === 1) {
      await evaluate(
        `(() => { const b = document.querySelector('button[aria-label="插件排序方式"]'); b.focus(); b.click() })()`,
      )
      await waitFor("document.querySelector('[role=menu]')", 'sort menu')
      const items = await evaluate(
        "[...document.querySelectorAll('[role=menu] button')].map(b => b.id)",
      )
      await key('End', 35)
      await waitFor(
        `document.querySelector('[role=menu]').getAttribute('aria-activedescendant') === ${JSON.stringify(items.at(-1))}`,
        'menu End',
      )
      await key('Home', 36)
      await waitFor(
        `document.querySelector('[role=menu]').getAttribute('aria-activedescendant') === ${JSON.stringify(items[0])}`,
        'menu Home',
      )
      await key('ArrowUp', 38)
      await waitFor(
        `document.querySelector('[role=menu]').getAttribute('aria-activedescendant') === ${JSON.stringify(items.at(-1))}`,
        'menu wrap',
      )
      await key('Escape', 27)
      await waitFor("!document.querySelector('[role=menu]')", 'menu Escape')
      assert.equal(
        await evaluate("document.activeElement.getAttribute('aria-label')"),
        '插件排序方式',
        'menu opener focus',
      )
    }
    const card = await evaluate(
      `(() => { const b = document.querySelector('button[aria-label*=" · "]'); return b ? {label:b.getAttribute('aria-label'), nested:b.querySelectorAll('button,[role="button"]').length} : null })()`,
    )
    if (card) {
      assert.equal(card.nested, 0, 'nested interactive plugin card')
      await evaluate(
        `(() => { const b = document.querySelector('button[aria-label=${JSON.stringify(card.label)}]'); b.focus(); b.click() })()`,
      )
      await waitFor(
        "document.querySelector('[role=dialog]')?.contains(document.activeElement)",
        'detail initial focus',
      )
      await waitFor("!document.querySelector('[role=dialog] .animate-spin')", 'detail metadata')
      assert(
        await evaluate("document.querySelector('[role=dialog]').contains(document.activeElement)"),
        'detail lost focus',
      )
      const stops =
        "[...document.querySelectorAll('[role=dialog] button:not(:disabled),[role=dialog] input:not(:disabled)')].filter(b => b.tabIndex >= 0 && b.getClientRects().length)"
      await evaluate(`${stops}.at(-1).focus()`)
      await key('Tab', 9)
      assert(await evaluate(`document.activeElement === ${stops}[0]`), 'forward modal focus wrap')
      await key('Tab', 9, 8)
      assert(
        await evaluate(`document.activeElement === ${stops}.at(-1)`),
        'reverse modal focus wrap',
      )
      await key('Escape', 27)
      await waitFor("!document.querySelector('[role=dialog]')", 'detail closes with Escape')
      assert.equal(
        await evaluate('document.activeElement.getAttribute("aria-label")'),
        card.label,
        'card focus restored',
      )
    }
    const metrics = (await command('Performance.getMetrics')).metrics
    const runtime = await evaluate(
      "window.__TAURI_INTERNALS__.invoke('harness_status').then(s => ({phase:s.phase, pid:s.phase === 'ready' ? s.pid : null}))",
    )
    if (requireReady) assert.equal(runtime.phase, 'ready', 'Harness lost readiness during soak')
    const record = {
      pass,
      elapsedSeconds: Math.round((Date.now() - started) / 1000),
      exceptions: exceptions.length,
      runtime,
      metrics: Object.fromEntries(
        metrics
          .filter((m) =>
            ['JSHeapUsedSize', 'Nodes', 'Documents', 'JSEventListeners'].includes(m.name),
          )
          .map((m) => [m.name, m.value]),
      ),
    }
    await appendFile(join(output, 'passes.jsonl'), `${JSON.stringify(record)}\n`)
    assert.equal(exceptions.length, 0, `renderer exceptions: ${exceptions.join('; ')}`)
    if (pass === 1 || pass % 20 === 0) await capture(`market-pass-${pass}.png`)
    console.log(JSON.stringify(record))
    if (Date.now() >= deadline) break
    await pause(Math.min(30000, deadline - Date.now()))
  } while (Date.now() < deadline)
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        passes: pass,
        started: new Date(started).toISOString(),
        ended: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
} catch (error) {
  await capture(`failure-pass-${pass}.png`).catch(() => {})
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'failed',
        passes: pass,
        error: String(error),
        started: new Date(started).toISOString(),
        ended: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  for (const request of pending.values()) clearTimeout(request.timer)
  socket.close()
}

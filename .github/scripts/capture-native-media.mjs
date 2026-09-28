// Capture actual isolated desktop pages; never mock IPC or enable remote access.
// Local filesystem and LAN labels are blurred. No other content is replaced.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [qaHome, output, port = '9223'] = process.argv.slice(2)
assert(qaHome && output, 'usage: capture-native-media.mjs QA_HOME OUTPUT [PORT]')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const targets = await fetch(`http://127.0.0.1:${Number(port)}/json`).then((r) => r.json())
const target = targets.find((item) => item.type === 'page')
assert(target?.webSocketDebuggerUrl, 'no WebView target')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((accept, reject) => {
  socket.addEventListener('open', accept, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 0
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
  const id = ++nextId
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 30000)
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
const pause = (ms) => new Promise((accept) => setTimeout(accept, ms))
async function waitFor(expression, label) {
  const deadline = Date.now() + 30000
  do {
    if (await evaluate(`Boolean(${expression})`)) return
    await pause(100)
  } while (Date.now() < deadline)
  throw new Error(`capture timeout: ${label}`)
}
const normalize = (value) => resolve(value).replaceAll('\\', '/').toLowerCase()
let localeScript
const captures = []
try {
  await command('Page.enable')
  const identity = await evaluate(`(async()=>({
    profile:(await window.__TAURI_INTERNALS__.invoke('plugin_state')).profileDir,
    version:(await window.__TAURI_INTERNALS__.invoke('app_about')).version,
  }))()`)
  assert(
    normalize(identity.profile).startsWith(`${normalize(qaHome)}/profiles/`),
    'not isolated QA',
  )
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  for (const locale of ['en-US', 'zh-CN']) {
    if (localeScript)
      await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: localeScript })
    localeScript = (
      await command('Page.addScriptToEvaluateOnNewDocument', {
        source: `Object.defineProperty(navigator, 'language', {value:${JSON.stringify(locale)}, configurable:true})`,
      })
    ).identifier
    await command('Page.reload')
    await waitFor(
      `document.querySelector('aside') && navigator.language === ${JSON.stringify(locale)}`,
      'localized shell',
    )
    const zh = locale === 'zh-CN'
    for (const [name, label, heading] of [
      ['console', zh ? '运行状态' : 'Runtime', zh ? '运行状态' : 'Runtime'],
      ['plugin-install', zh ? '插件' : 'Plugins', zh ? '插件市场' : 'Plugin marketplace'],
      ['remote-pairing', zh ? '远程' : 'Remote', zh ? '远程访问' : 'Remote access'],
    ]) {
      assert(
        await evaluate(
          `(()=>{const b=[...document.querySelectorAll('aside button')].find(b=>b.innerText.trim().split('\\n')[0]===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`,
        ),
        `missing route ${label}`,
      )
      await waitFor(
        `[...document.querySelectorAll('h1,h2')].some(h=>h.getClientRects().length && h.innerText.trim()===${JSON.stringify(heading)})`,
        heading,
      )
      if (name === 'plugin-install')
        await waitFor(
          `document.querySelector('button[aria-label*=" · "]')`,
          'real marketplace results',
        )
      await evaluate('document.fonts.ready.then(()=>true)')
      await pause(500)
      const state = await evaluate(`(()=>{
        let blurred=0;
        for(const b of document.querySelectorAll('button[aria-label]')) {
          if(/^[A-Za-z]:[\\\\/]/.test(b.getAttribute('aria-label'))) {b.style.filter='blur(8px)';blurred++}
        }
        for(const item of document.querySelectorAll('li.selectable')) {
          if(/^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$/.test(item.innerText.trim())) {item.style.filter='blur(8px)';blurred++}
        }
        return {overflow:document.documentElement.scrollWidth>innerWidth,blurred,
          dialogs:document.querySelectorAll('[role=dialog],[role=alertdialog]').length};
      })()`)
      assert(!state.overflow && state.dialogs === 0, 'invalid screenshot state')
      const filename = `${name}${zh ? '.zh' : ''}.png`
      const screenshot = await command('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      })
      await writeFile(join(root, 'assets', filename), Buffer.from(screenshot.data, 'base64'))
      captures.push({
        filename,
        locale,
        version: identity.version,
        privacyBlurredLabels: state.blurred,
      })
    }
  }
  await mkdir(resolve(output), { recursive: true })
  await writeFile(
    join(resolve(output), 'native-captures.json'),
    JSON.stringify(
      {
        source:
          'actual isolated Windows desktop; local path/LAN labels blurred; remote access not enabled',
        captures,
        completed: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify(captures, null, 2))
} finally {
  if (localeScript)
    await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: localeScript })
  await command('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await command('Page.reload').catch(() => {})
  for (const request of pending.values()) clearTimeout(request.timer)
  socket.close()
}

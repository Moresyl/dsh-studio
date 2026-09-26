// Capture the shipped React UI against media/world.ts's deterministic backend.
// Requires the local Vite server and an isolated browser with CDP enabled.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [port = '9224', scratch] = process.argv.slice(2)
assert(scratch, 'usage: capture-media.mjs CDP_PORT SCRATCH_DIRECTORY')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const targets = await fetch(`http://127.0.0.1:${Number(port)}/json`).then((r) => r.json())
const target = targets.find((item) => item.type === 'page')
assert(target?.webSocketDebuggerUrl, 'no browser target')
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
  })
  assert(
    !result.exceptionDetails,
    result.exceptionDetails?.exception?.description ?? 'capture evaluation failed',
  )
  return result.result.value
}
async function capture(path) {
  const result = await command('Page.captureScreenshot', { format: 'png', fromSurface: true })
  await writeFile(path, Buffer.from(result.data, 'base64'))
}
try {
  await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1120,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  })
  for (const lang of ['en', 'zh']) {
    for (const scene of ['console', 'plugins', 'remote']) {
      const suffix = lang === 'zh' ? '.zh' : ''
      const mode = scene === 'console' ? 'pose' : 'scene'
      await command('Page.navigate', {
        url: `http://127.0.0.1:1420/media/?${mode}=${scene}&lang=${lang}&theme=dark`,
      })
      let ready = false
      for (let attempt = 0; attempt < 200; attempt++) {
        await new Promise((accept) => setTimeout(accept, 100))
        const state = await evaluate('({ready:window.dsh?.ready,error:window.dsh?.error})')
        assert(!state.error, state.error)
        if (state.ready) {
          ready = true
          break
        }
      }
      assert(ready, `${scene} did not become ready`)
      await evaluate('document.fonts.ready.then(() => true)')
      if (mode === 'pose') {
        await capture(join(root, 'assets', `console${suffix}.png`))
      } else {
        const frames = join(resolve(scratch), `${scene}-${lang}`)
        await mkdir(frames, { recursive: true })
        const plan = await evaluate('window.dsh.plan()')
        await writeFile(join(frames, 'plan.json'), JSON.stringify(plan))
        await capture(join(frames, 'frame-000.png'))
        for (let index = 1; index < plan.length; index++) {
          const progress = await evaluate('window.dsh.step()')
          assert.equal(progress.index, index + 1)
          await capture(join(frames, `frame-${String(index).padStart(3, '0')}.png`))
        }
        const name = scene === 'plugins' ? 'plugin-install' : 'remote-pairing'
        await promisify(execFile)(
          process.execPath,
          [join(root, 'media/apng.mjs'), frames, join(root, 'assets', `${name}${suffix}.png`)],
          { windowsHide: true },
        )
      }
      console.log(`captured ${scene} ${lang}`)
    }
  }
} finally {
  for (const request of pending.values()) clearTimeout(request.timer)
  socket.close()
}

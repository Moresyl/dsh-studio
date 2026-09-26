import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const port = Number(process.env.DSH_STUDIO_WEBVIEW_DEBUG_PORT ?? process.argv[2] ?? 9223)
const mode = process.argv[3] ?? 'inspect'

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`invalid WebView debug port: ${port}`)
}

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => {
  if (!response.ok) throw new Error(`WebView target discovery failed: HTTP ${response.status}`)
  return response.json()
})
const target = targets.find((candidate) => candidate.type === 'page')
if (!target?.webSocketDebuggerUrl) throw new Error('no debuggable WebView page was found')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true })
  socket.addEventListener('error', () => reject(new Error('WebView CDP connection failed')), {
    once: true,
  })
})

let nextId = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error) request.reject(new Error(message.error.message))
  else request.resolve(message.result)
})

function command(method, params = {}) {
  const id = ++nextId
  return new Promise((resolveCommand, reject) => {
    pending.set(id, { resolve: resolveCommand, reject })
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
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.exception?.value ??
        result.exceptionDetails.text,
    )
  }
  return result.result.value
}

await command('Runtime.enable')
await command('Page.enable')

if (mode === 'inspect') {
  const state = await evaluate(`(() => ({
    title: document.title,
    url: location.href,
    ready: document.readyState,
    tauri: Boolean(window.__TAURI_INTERNALS__),
    text: document.body.innerText,
    buttons: [...document.querySelectorAll('button')].map((button, index) => ({
      index,
      text: button.innerText.trim(),
      label: button.getAttribute('aria-label'),
      current: button.getAttribute('aria-current'),
      disabled: button.disabled,
    })),
    inputs: [...document.querySelectorAll('input, textarea, select')].map((input, index) => ({
      index,
      tag: input.tagName,
      type: input.type,
      label: input.getAttribute('aria-label'),
      placeholder: input.getAttribute('placeholder'),
      value: input.value,
      disabled: input.disabled,
    })),
  }))()`)
  console.log(JSON.stringify(state, null, 2))
} else if (mode === 'screenshot') {
  const image = await command('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = resolve(process.argv[4] ?? 'artifacts/desktop-ui.png')
  await writeFile(path, Buffer.from(image.data, 'base64'))
  console.log(path)
} else if (mode === 'eval') {
  const expression = process.argv.slice(4).join(' ')
  if (!expression) throw new Error('eval mode requires a JavaScript expression')
  console.log(JSON.stringify(await evaluate(expression), null, 2))
} else if (mode === 'viewport') {
  const width = Number(process.argv[4])
  const height = Number(process.argv[5])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 240) {
    throw new Error('viewport mode requires integer width and height')
  }
  await command('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  console.log(JSON.stringify({ width, height }))
} else if (mode === 'viewport-reset') {
  await command('Emulation.clearDeviceMetricsOverride')
  console.log(JSON.stringify({ reset: true }))
} else {
  throw new Error(`unknown desktop UI acceptance mode: ${mode}`)
}

socket.close()

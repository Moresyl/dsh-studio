// Long-session fixture and render timing in the actual isolated desktop WebView.
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [qaHome, output, port = '9223', mode = 'bounded'] = process.argv.slice(2)
if (!qaHome || !output)
  throw new Error('usage: desktop-session-regression.mjs QA_HOME OUTPUT [PORT] [baseline|bounded]')
const destination = resolve(output)
const helper = join(dirname(fileURLToPath(import.meta.url)), 'desktop-ui-acceptance.mjs')
const evaluate = async (expression) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [helper, port, 'eval', expression],
    { timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true },
  ).catch((cause) => {
    throw new Error(cause.stderr || cause.message)
  })
  return JSON.parse(stdout)
}
const normalized = (value) => resolve(value).replaceAll('\\', '/').toLowerCase()
const profileDir = await evaluate(
  "window.__TAURI_INTERNALS__.invoke('plugin_state').then(p=>p.profileDir)",
)
if (!normalized(profileDir).startsWith(`${normalized(qaHome)}/profiles/`))
  throw new Error('not the isolated QA profile')
await mkdir(destination, { recursive: true })
const id = `qa-long-${Date.now().toString(36)}`
const sessionDir = join(resolve(qaHome), 'sessions', 'qa-performance', id)
await mkdir(dirname(sessionDir), { recursive: true })
await mkdir(sessionDir)
const lineCount = 4000
const now = Date.now()
const rows = [{ type: 'session', version: 0, id, createdAt: now, cwd: destination }]
for (let index = 1; index <= lineCount; index++) {
  const message = {
    source: { kind: index % 2 ? 'user' : 'assistant', model: 'qa-fixture' },
    content: [
      {
        type: 'text',
        text: `QA long transcript ${id} entry ${index}\n${index === lineCount ? `needle-${id}\n` : ''}${'Long-session rendering acceptance. '.repeat(24)}`,
      },
    ],
  }
  rows.push({
    type: index % 2 ? 'user/message' : 'assistant/message',
    seq: index,
    time: now + index,
    data: index % 2 ? message : { message },
  })
}

async function checkSession({ id, lineCount, mode }) {
  const assert = (value, label) => {
    if (!value) throw new Error(label)
  }
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise((accept) => setTimeout(accept, 30))
    }
    throw new Error(`long-session acceptance timeout: ${label}`)
  }
  const click = (text, scope = document) => {
    const button = [...scope.querySelectorAll('button')].find(
      (item) => item.innerText.trim().split('\n')[0] === text,
    )
    assert(button && !button.disabled, `missing action: ${text}`)
    button.click()
  }
  const nativeStarted = performance.now()
  const transcript = await window.__TAURI_INTERNALS__.invoke('session_read', { id })
  assert(transcript.lines.length === lineCount, 'native transcript was incomplete')
  const nativeReadMs = performance.now() - nativeStarted
  const back = [...document.querySelectorAll('button')].find(
    (button) => button.innerText.trim() === '返回全部会话',
  )
  back?.click()
  click('关于', document.querySelector('aside'))
  await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)))
  click('会话', document.querySelector('aside'))
  await wait(() => document.querySelector('button[aria-label="重新查找会话"]'), 'session shelf')
  await wait(
    () => !document.querySelector('button[aria-label="重新查找会话"]').disabled,
    'initial scan',
  )
  document.querySelector('button[aria-label="重新查找会话"]').click()
  await wait(
    () =>
      [...document.querySelectorAll('[role="button"]')].some((row) => row.innerText.includes(id)),
    'fixture listed',
  )
  const entry = [...document.querySelectorAll('[role="button"]')].find((row) =>
    row.innerText.includes(id),
  )
  const started = performance.now()
  entry.click()
  await wait(() => document.querySelector('[data-seq]'), 'transcript mounted')
  await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)))
  const initialRows = document.querySelectorAll('[data-seq]').length
  const renderMs = performance.now() - started
  const domNodes = document.getElementsByTagName('*').length
  if (mode !== 'baseline') {
    assert(initialRows <= 120, `unbounded rendered transcript: ${initialRows}`)
    const action = (label) => {
      const button = document.querySelector(`button[aria-label="${label}"]`)
      assert(button && !button.disabled, `missing pagination action: ${label}`)
      button.click()
    }
    action('下一段消息')
    await wait(() => document.querySelector('[data-seq="121"]'), 'next segment')
    action('上一段消息')
    await wait(() => document.querySelector('[data-seq="1"]'), 'previous segment')
    action('最新消息')
    await wait(() => document.querySelector(`[data-seq="${lineCount}"]`), 'last segment')
    assert(document.querySelectorAll('[data-seq]').length === 40, 'incorrect last segment size')
    assert(document.querySelector('button[aria-label="下一段消息"]').disabled, 'next past last')
    action('最早消息')
    await wait(() => document.querySelector('[data-seq="1"]'), 'first segment')
    click('返回全部会话')
    await wait(() => document.querySelector('input[type="search"]'), 'search field')
    const field = document.querySelector('input[type="search"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
      field,
      `needle-${id}`,
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(
      () =>
        [...document.querySelectorAll('mark')].some((mark) =>
          mark.textContent.includes(`needle-${id}`),
        ),
      'last message search hit',
    )
    const mark = [...document.querySelectorAll('mark')].find((mark) =>
      mark.textContent.includes(`needle-${id}`),
    )
    mark.closest('button').click()
    await wait(() => document.querySelector(`[data-seq="${lineCount}"]`), 'search anchor segment')
    await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)))
    const hit = document.querySelector(`[data-seq="${lineCount}"]`).getBoundingClientRect()
    assert(hit.top < innerHeight && hit.bottom > 0, 'search hit was not scrolled into view')
    assert(document.querySelectorAll('[data-seq]').length <= 120, 'search mounted all messages')
  }
  const exported = await window.__TAURI_INTERNALS__.invoke('session_export', {
    id,
    format: 'markdown',
  })
  assert(exported.text.includes(`entry ${lineCount}\n`), 'export omitted the last message')
  return {
    mode,
    lineCount,
    initialRows,
    nativeReadMs,
    renderMs,
    domNodes,
    warmNativeCache: true,
    completed: new Date().toISOString(),
  }
}

try {
  await writeFile(
    join(sessionDir, 'session.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  )
  const result = await evaluate(
    `(${checkSession.toString()})(${JSON.stringify({ id, lineCount, mode })})`,
  )
  await promisify(execFile)(
    process.execPath,
    [helper, port, 'screenshot', join(destination, 'session-normal.png')],
    { windowsHide: true },
  )
  if (mode !== 'baseline') {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        helper,
        port,
        'viewport',
        '900',
        '620',
        join(destination, 'session-compact.png'),
        'forced-colors',
      ],
      { windowsHide: true },
    )
    result.compact = JSON.parse(stdout)
    if (result.compact.overflow) throw new Error('compact transcript overflows the window')
  }
  await writeFile(join(destination, `session-${mode}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await evaluate(`(async () => {
    [...document.querySelectorAll('button')].find(button => button.innerText.trim() === '返回全部会话')?.click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const field = document.querySelector('input[type="search"]');
    if (field) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '');
      field.dispatchEvent(new Event('input', {bubbles: true}));
    }
    return true;
  })()`).catch((cause) => console.error(`QA view cleanup failed: ${cause.message}`))
  await rm(sessionDir, { recursive: true })
}

// Actual UI and native PTY acceptance. Refuses non-QA profiles and existing shells.
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [qaHome, output, port = '9223'] = process.argv.slice(2)
if (!qaHome || !output)
  throw new Error('usage: desktop-terminal-regression.mjs QA_HOME OUTPUT [PORT]')
const destination = resolve(output)
await mkdir(destination, { recursive: true })

async function checkTerminals(qaHome) {
  const invoke = (name, args) => window.__TAURI_INTERNALS__.invoke(name, args)
  const assert = (condition, label) => {
    if (!condition) throw new Error(label)
  }
  const normalize = (value) => value.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '')
  const profile = await invoke('plugin_state')
  assert(
    normalize(profile.profileDir).startsWith(`${normalize(qaHome)}/profiles/`),
    'not a QA profile',
  )
  assert((await invoke('terminal_list')).length === 0, 'existing shells: refusing to disturb them')
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise((accept) => setTimeout(accept, 50))
    }
    throw new Error(`terminal acceptance timeout: ${label}`)
  }
  const clickText = (text, scope = document) => {
    const button = [...scope.querySelectorAll('button')].find(
      (b) => b.innerText.trim().split('\n')[0] === text,
    )
    assert(button && !button.disabled, `missing button: ${text}`)
    button.click()
  }
  const panes = () => [...document.querySelectorAll('[data-terminal-id]')]
  const select = async (id) => {
    const button = [...document.querySelectorAll('[data-terminal-tab]')].find(
      (b) => b.dataset.terminalTab === id,
    )
    assert(button, `missing terminal tab ${id}`)
    button.click()
    await wait(
      () => document.querySelector('[data-terminal-active="true"]')?.dataset.terminalId === id,
      'pane selection',
    )
  }
  const chooseLayout = async (label, count) => {
    const trigger = document.querySelector('[aria-label="终端布局"]')
    assert(trigger, 'new terminal layout UI is missing')
    trigger.click()
    await wait(() => document.querySelector('[role="menu"]'), 'layout menu')
    clickText(label, document.querySelector('[role="menu"]'))
    await wait(() => panes().length === count && !document.querySelector('[role="menu"]'), label)
    await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)))
    for (const pane of panes()) {
      const bounds = pane.getBoundingClientRect()
      assert(bounds.width > 100 && bounds.height > 80, `${label}: collapsed pane`)
      assert(
        pane.querySelectorAll('.xterm').length === 1,
        `${label}: missing or duplicate emulator`,
      )
    }
    assert(document.documentElement.scrollWidth <= innerWidth, `${label}: horizontal overflow`)
  }
  const created = []
  const previousLayout = localStorage.getItem('dsh-studio:terminal-layout:v1')
  const checks = []
  try {
    clickText('终端', document.querySelector('aside'))
    await wait(() => document.querySelector('[aria-label="终端布局"]'), 'terminal page')
    for (let index = 0; index < 5; index++) {
      clickText('新建终端')
      await wait(
        async () => (await invoke('terminal_list')).length === index + 1,
        'native shell creation',
      )
      const roster = await invoke('terminal_list')
      const added = roster.find((item) => !created.some((known) => known.id === item.id))
      assert(added, 'new shell identity missing')
      created.push(added)
      await wait(
        () => document.querySelectorAll('[data-terminal-tab]').length === index + 1,
        'tab creation',
      )
    }
    await select(created[0].id)
    await chooseLayout('左右分屏', 2)
    const pair = panes().map((pane) => pane.dataset.terminalId)
    await select(created[1].id)
    assert(
      JSON.stringify(panes().map((pane) => pane.dataset.terminalId)) === JSON.stringify(pair),
      'focus rearranged panes',
    )
    await chooseLayout('上下分屏', 2)
    assert(
      panes()[1].getBoundingClientRect().top > panes()[0].getBoundingClientRect().top,
      'stacked panes overlap',
    )
    await chooseLayout('四宫格', 4)
    checks.push('five real shells; stable two-pane groups; stacked layout; bounded four-pane grid')
    for (const shell of created.slice(0, 4)) {
      await invoke('terminal_write', { id: shell.id, data: "echo ('LAYOUT_' + 'PROOF')\r" })
    }
    await wait(
      () => panes().every((pane) => pane.innerText.includes('LAYOUT_PROOF')),
      'independent output in all four emulators',
    )
    const before = (await invoke('terminal_list')).map((shell) => shell.id).sort()
    await chooseLayout('单窗口', 1)
    await chooseLayout('四宫格', 4)
    await wait(
      () => panes().every((pane) => pane.innerText.includes('LAYOUT_PROOF')),
      'scrollback retained',
    )
    assert(
      JSON.stringify((await invoke('terminal_list')).map((shell) => shell.id).sort()) ===
        JSON.stringify(before),
      'layout respawned a shell',
    )
    checks.push('output and process identity survive layout transitions')
    await select(created[4].id)
    assert(panes().length === 1, 'last incomplete grid shows phantom panes')
    await select(created[0].id)
    clickText('设置', document.querySelector('aside'))
    await wait(() => panes().length === 0, 'terminal route detached')
    clickText('终端', document.querySelector('aside'))
    await wait(
      () =>
        panes().length === 4 && panes().every((pane) => pane.innerText.includes('LAYOUT_PROOF')),
      'route return retained transcript',
    )
    assert(
      localStorage.getItem('dsh-studio:terminal-layout:v1') === 'grid',
      'layout preference not persisted',
    )
    checks.push('last group, route round trip and layout preference persistence')
    await invoke('terminal_write', { id: created[0].id, data: 'exit 7\r' })
    await wait(
      async () => !(await invoke('terminal_list')).some((shell) => shell.id === created[0].id),
      'abnormal shell exit',
    )
    await wait(
      () => panes().some((pane) => pane.innerText.includes('退出码 7')),
      'failed shell transcript',
    )
    await chooseLayout('左右分屏', 2)
    await chooseLayout('上下分屏', 2)
    assert(
      !document.body.innerText.includes('no longer open'),
      'resizing a finished transcript called a dead PTY',
    )
    checks.push('failed transcript remains readable and resizes without dead-process IPC')
    const second = panes().find((pane) => pane.dataset.terminalId === created[1].id)
    assert(second, 'second pane missing before context-menu check')
    second.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 400,
        clientY: 300,
      }),
    )
    await wait(() => document.querySelector('[role="menu"]'), 'pane context menu')
    clickText('关闭终端', document.querySelector('[role="menu"]'))
    await wait(
      async () => !(await invoke('terminal_list')).some((shell) => shell.id === created[1].id),
      'context menu closes clicked pane',
    )
    assert(
      (await invoke('terminal_list')).some((shell) => shell.id === created[2].id),
      'context menu closed a different pane',
    )
    checks.push('right-click close targets the clicked pane, not the previous selection')
  } finally {
    for (const shell of created) {
      const tab = [...document.querySelectorAll('[data-terminal-tab]')].find(
        (button) => button.dataset.terminalTab === shell.id,
      )
      const close = tab?.parentElement.querySelector('[aria-label="关闭终端"]')
      if (close) {
        close.click()
        await wait(
          () =>
            ![...document.querySelectorAll('[data-terminal-tab]')].some(
              (button) => button.dataset.terminalTab === shell.id,
            ),
          'test tab cleanup',
        )
      } else if ((await invoke('terminal_list')).some((item) => item.id === shell.id)) {
        await invoke('terminal_close', { id: shell.id })
      }
    }
    if (previousLayout === null) localStorage.removeItem('dsh-studio:terminal-layout:v1')
    else localStorage.setItem('dsh-studio:terminal-layout:v1', previousLayout)
    if (window.__DSH_SAVED_PREFERENCES__) {
      await invoke('preference_save', {
        key: 'dsh-studio:terminal-layout:v1',
        value: previousLayout ?? 'single',
      })
    }
  }
  await wait(async () => (await invoke('terminal_list')).length === 0, 'QA shell cleanup')
  checks.push('all test-owned PTYs closed')
  return { checks, completed: new Date().toISOString() }
}

const runner = join(dirname(fileURLToPath(import.meta.url)), 'desktop-ui-acceptance.mjs')
const { stdout } = await promisify(execFile)(
  process.execPath,
  [runner, port, 'eval', `(${checkTerminals.toString()})(${JSON.stringify(resolve(qaHome))})`],
  { timeout: 180000, maxBuffer: 1024 * 1024 },
).catch((cause) => {
  throw new Error(cause.stderr || cause.message)
})
const result = JSON.parse(stdout)
await writeFile(join(destination, 'terminal-layout.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

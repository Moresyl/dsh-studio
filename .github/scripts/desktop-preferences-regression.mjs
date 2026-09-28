// Same-window reload acceptance against actual native persistence, not a mock.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [qaHome, output, port = '9223'] = process.argv.slice(2)
assert(qaHome && output, 'usage: desktop-preferences-regression.mjs QA_HOME OUTPUT [PORT]')
const execute = promisify(execFile)
const runner = join(dirname(fileURLToPath(import.meta.url)), 'desktop-ui-acceptance.mjs')
async function evaluate(source) {
  const { stdout } = await execute(process.execPath, [runner, port, 'eval', source], {
    windowsHide: true,
  })
  return JSON.parse(stdout)
}
const normalize = (value) => resolve(value).replaceAll('\\', '/').toLowerCase()
const identity = await evaluate(`(async () => ({
  profile: (await window.__TAURI_INTERNALS__.invoke('plugin_state')).profileDir,
  data: (await window.__TAURI_INTERNALS__.invoke('app_about')).appData,
  theme: localStorage.getItem('dsh-studio.theme') ?? 'system',
  boot: localStorage.getItem('dsh-studio:preferences:boot'),
}))()`)
assert(normalize(identity.profile).startsWith(`${normalize(qaHome)}/profiles/`), 'not isolated QA')
assert(
  normalize(identity.data).startsWith(`${normalize(dirname(resolve(qaHome)))}/`),
  'native data outside QA root',
)
const labels = { light: '浅色', dark: '深色', system: '跟随系统' }
async function choose(theme) {
  await evaluate(
    `(() => {const button = document.querySelector('button[aria-label="${labels[theme]}"]'); if (!button) throw new Error('theme action missing'); button.click(); return true;})()`,
  )
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const values = JSON.parse(await readFile(join(identity.data, 'preferences.json'), 'utf8'))
    if (values['dsh-studio.theme'] === theme) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('theme was not durably saved by the UI')
}
const checks = []
try {
  for (const theme of ['light', 'dark', 'light']) {
    await choose(theme)
    await execute(process.execPath, [runner, port, 'eval', 'location.reload()'], {
      windowsHide: true,
    })
    const state = await evaluate(`(async () => {
      const deadline = Date.now() + 10000;
      while (!document.querySelector('aside') && Date.now() < deadline) await new Promise(r=>setTimeout(r,30));
      return {theme:document.documentElement.dataset.theme, stored:localStorage.getItem('dsh-studio.theme'), boot:localStorage.getItem('dsh-studio:preferences:boot')};
    })()`)
    assert.equal(state.theme, theme)
    assert.equal(state.stored, theme)
    assert.equal(state.boot, identity.boot)
    checks.push(`UI choice ${theme} was saved natively and survived same-window reload`)
  }
} finally {
  await choose(identity.theme)
}
await mkdir(resolve(output), { recursive: true })
const result = { checks, completed: new Date().toISOString() }
await writeFile(join(resolve(output), 'preferences-reload.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

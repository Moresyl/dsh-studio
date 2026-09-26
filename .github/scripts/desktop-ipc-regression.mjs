// Exercises native commands through the real WebView ACL, using QA data only.
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [qaHome, output, port = '9223'] = process.argv.slice(2)
if (!qaHome || !output) throw new Error('usage: desktop-ipc-regression.mjs QA_HOME OUTPUT [PORT]')
const destination = resolve(output)
await mkdir(destination, { recursive: true })

async function checkNative({ qaHome, output, fixtureId }) {
  const api = window.__TAURI_INTERNALS__
  const invoke = (name, args) => api.invoke(name, args)
  const check = (condition, label) => {
    if (!condition) throw new Error(label)
  }
  const normalize = (value) => value.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '')
  const profile = await invoke('plugin_state')
  check(
    normalize(profile.profileDir).startsWith(`${normalize(qaHome)}/profiles/`),
    'not an isolated QA profile',
  )
  const checks = []
  check((await invoke('desktop_file_offer')) === null, 'unexpected pending file offer')
  checks.push('desktop_file_offer passed the real WebView ACL')
  const prefix = `qa-${Date.now().toString(36)}`
  const created = new Set()
  let terminal
  let eventId
  let callback
  try {
    const a = `${prefix}-a`
    const b = `${prefix}-b`
    const c = `${prefix}-c`
    const imported = `${prefix}-import`
    await invoke('profile_create', { name: a })
    created.add(a)
    await invoke('profile_duplicate', { source: a, name: b })
    created.add(b)
    const comparison = await invoke('profile_compare', { left: a, right: b })
    check(comparison.differences === 0, 'fresh profile copy differs')
    await invoke('profile_rename', { from: b, to: c })
    created.delete(b)
    created.add(c)
    const path = `${output}/${prefix}.json`
    await invoke('profile_export', { name: a, path })
    const declaration = await invoke('profile_declaration', { path })
    check(declaration.verified === true && declaration.name === a, 'profile export integrity')
    await invoke('profile_import', { path, name: imported })
    created.add(imported)
    const roundTrip = await invoke('profile_compare', { left: a, right: imported })
    check(roundTrip.differences === 0, 'profile import differs')
    let rejected = false
    try {
      await invoke('profile_create', { name: '../qa-invalid' })
    } catch {
      rejected = true
    }
    check(rejected, 'unsafe profile name accepted')
    checks.push(
      'profile create, duplicate, compare, rename, export, verified import and invalid-name rejection',
    )

    const presets = await invoke('preset_roster')
    const preset = presets.presets.find((item) => item.id === fixtureId && !item.shipped)
    check(preset, 'QA preset fixture is missing')
    try {
      const choice = await invoke('preset_choose', { id: 'minimal' })
      check(choice.default === 'minimal', 'preset selection did not persist')
    } finally {
      await invoke('preset_choose', { id: presets.default ?? 'standard' })
    }
    const presetPath = `${output}/${prefix}.dshpreset`
    await invoke('preset_export', { id: preset.id, path: presetPath })
    const preview = await invoke('preset_package', { path: presetPath })
    check(
      preview.id === preset.id && preview.integrityVerified && preview.files > 0,
      'preset package integrity',
    )
    rejected = false
    try {
      await invoke('preset_import', { path: presetPath })
    } catch {
      rejected = true
    }
    check(rejected, 'duplicate preset replaced an existing preset')
    checks.push('preset selection, export, package preview and duplicate import protection')

    const sessions = await invoke('session_roster')
    check(
      sessions.cards.some((item) => item.id === fixtureId),
      'session fixture not indexed',
    )
    const hits = await invoke('session_search', { query: 'QA session acceptance', project: null })
    check(
      hits.some((item) => item.card.id === fixtureId),
      'session search missed fixture',
    )
    const transcript = await invoke('session_read', { id: fixtureId })
    check(transcript.lines.length === 2, 'session transcript lost messages')
    for (const format of ['markdown', 'html', 'json']) {
      const exported = await invoke('session_export', { id: fixtureId, format })
      check(exported.text.includes('QA session acceptance'), `empty ${format} export`)
      await invoke('session_save', { path: `${output}/${exported.name}`, text: exported.text })
    }
    try {
      const archived = await invoke('session_archive', { id: fixtureId, archived: true })
      check(archived.archived.includes(fixtureId), 'session archive was not persisted')
    } finally {
      await invoke('session_archive', { id: fixtureId, archived: false })
    }
    checks.push(
      'session indexing, search, transcript, three export formats, save and archive restore',
    )

    let received = ''
    const early = new Map()
    const answerCursor = (data) => {
      // A raw PTY test has no xterm emulator to answer ConPTY's cursor-position
      // query. This is the VT response a mounted emulator normally supplies.
      if (terminal && data.includes('\u001b[6n')) {
        void invoke('terminal_write', { id: terminal.id, data: '\u001b[1;1R' }).catch(() => {})
      }
    }
    callback = api.transformCallback((event) => {
      if (event.payload.id === terminal?.id) {
        received += event.payload.data
        answerCursor(event.payload.data)
      } else if (!terminal) {
        early.set(event.payload.id, (early.get(event.payload.id) ?? '') + event.payload.data)
      }
    })
    eventId = await invoke('plugin:event|listen', {
      event: 'terminal://output',
      target: { kind: 'Any' },
      handler: callback,
    })
    terminal = await invoke('terminal_open', { rows: 24, cols: 100 })
    received = early.get(terminal.id) ?? ''
    early.clear()
    answerCursor(received)
    check(
      (await invoke('terminal_list')).some((item) => item.id === terminal.id),
      'PTY missing from roster',
    )
    await invoke('terminal_resize', { id: terminal.id, rows: 30, cols: 120 })
    await invoke('terminal_write', {
      id: terminal.id,
      data: /powershell|pwsh/i.test(terminal.label)
        ? "echo ('DSH_QA_NATIVE_' + 'PTY_OK')\r"
        : 'echo DSH_QA_NATIVE_PTY_OK\r',
    })
    const deadline = Date.now() + 15000
    while (!received.includes('DSH_QA_NATIVE_PTY_OK') && Date.now() < deadline)
      await new Promise((accept) => setTimeout(accept, 100))
    check(received.includes('DSH_QA_NATIVE_PTY_OK'), 'PTY produced no output')
    checks.push('PTY open, list, resize, write and output subscription')
  } finally {
    if (terminal) await invoke('terminal_close', { id: terminal.id })
    if (eventId !== undefined) {
      window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener('terminal://output', eventId)
      await invoke('plugin:event|unlisten', { event: 'terminal://output', eventId })
    }
    if (callback !== undefined) api.unregisterCallback(callback)
    for (const name of created) await invoke('profile_remove', { name })
  }
  const roster = await invoke('profile_roster')
  check(
    !roster.profiles.some((item) => item.name.startsWith(prefix)),
    'QA profile cleanup incomplete',
  )
  check(
    !(await invoke('terminal_list')).some((item) => item.id === terminal?.id),
    'QA PTY cleanup incomplete',
  )
  checks.push('QA profiles and terminal removed without changing the selected profile')
  return { checks, completed: new Date().toISOString() }
}

const helper = join(dirname(fileURLToPath(import.meta.url)), 'desktop-ui-acceptance.mjs')
async function evaluate(expression) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [helper, port, 'eval', expression],
    {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  )
  return JSON.parse(stdout)
}

// Verify the live instance before creating any fixture. Never point this tool
// at a normal user profile: launch the documented isolated QA instance first.
const actualProfile = await evaluate(
  "window.__TAURI_INTERNALS__.invoke('plugin_state').then(p => p.profileDir)",
)
const normalized = (value) => resolve(value).replaceAll('\\', '/').toLowerCase()
if (!normalized(actualProfile).startsWith(`${normalized(qaHome)}/profiles/`)) {
  throw new Error('The live WebView is not using QA_HOME')
}
const fixtureId = `qa-native-${Date.now().toString(36)}`
const presetDir = join(resolve(qaHome), '.agent-presets', fixtureId)
const sessionDir = join(resolve(qaHome), 'sessions', 'qa-native', fixtureId)
const created = []
try {
  for (const directory of [presetDir, sessionDir]) {
    await mkdir(dirname(directory), { recursive: true })
    await mkdir(directory)
    created.push(directory)
  }
  await writeFile(
    join(presetDir, 'preset.yml'),
    `name: ${fixtureId}\ndescription: Isolated QA fixture\n`,
  )
  await writeFile(join(presetDir, 'agent.cordis.yml'), '- id: qa-disabled\n  disabled: true\n')
  const now = Date.now()
  const rows = [
    { type: 'session', version: 0, id: fixtureId, createdAt: now, cwd: destination },
    {
      type: 'user/message',
      seq: 1,
      time: now,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'QA session acceptance <script>not executable</script>' }],
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: now + 1,
      data: {
        message: {
          source: { kind: 'assistant', model: 'qa-fixture' },
          content: [{ type: 'text', text: 'Isolated reply for export verification.' }],
        },
      },
    },
  ]
  await writeFile(
    join(sessionDir, 'session.jsonl'),
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
  )
  const expression = `(${checkNative.toString()})(${JSON.stringify({ qaHome: resolve(qaHome), output: destination, fixtureId })}).catch(error => ({ failed: true, error: String(error) }))`
  const result = await evaluate(expression)
  await writeFile(join(destination, 'native-result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (result.failed) process.exitCode = 1
} finally {
  // Only directories created exclusively by this run are removed.
  for (const directory of created) await rm(directory, { recursive: true })
}

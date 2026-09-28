// Exercise genuine native failure/retry without replacing the immutable IPC bridge.
// Only the exclusively created QA repository's .git directory is temporarily moved.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [qaHome, output, port = '9223'] = process.argv.slice(2)
assert(qaHome && output, 'usage: desktop-worktree-failure-regression.mjs QA_HOME OUTPUT [PORT]')
const execute = promisify(execFile)
const runner = join(dirname(fileURLToPath(import.meta.url)), 'desktop-ui-acceptance.mjs')
async function evaluate(source) {
  const { stdout } = await execute(process.execPath, [runner, port, 'eval', source], {
    windowsHide: true,
    timeout: 45000,
    maxBuffer: 1024 * 1024,
  }).catch((cause) => {
    throw new Error(cause.stderr || cause.message)
  })
  return JSON.parse(stdout)
}
const normalize = (value) => resolve(value).replaceAll('\\', '/').toLowerCase()
const identity = await evaluate(`(async () => ({
  profile: (await window.__TAURI_INTERNALS__.invoke('plugin_state')).profileDir,
  phase: (await window.__TAURI_INTERNALS__.invoke('harness_status')).phase,
  workspace: (await window.__TAURI_INTERNALS__.invoke('harness_environment')).workspace,
}))()`)
assert(
  normalize(identity.profile).startsWith(`${normalize(qaHome)}/profiles/`),
  'not the isolated QA profile',
)
assert.equal(identity.phase, 'stopped', 'stop QA Harness before changing workspace')
const destination = resolve(output)
await mkdir(destination, { recursive: true })
const repository = await mkdtemp(join(destination, 'failure-'))
const git = (...args) => execute('git', ['-C', repository, ...args], { windowsHide: true })
await git('init', '-b', 'main')
await git('config', 'user.name', 'Desktop QA')
await git('config', 'user.email', 'qa@example.invalid')
await git('config', 'core.autocrlf', 'false')
await git('config', 'core.hooksPath', join(repository, 'disabled-hooks'))
await writeFile(join(repository, 'tracked.txt'), 'base\n')
await git('add', 'tracked.txt')
await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'QA fixture')
await writeFile(join(repository, 'tracked.txt'), 'changed\n')
const before = (await git('status', '--porcelain=v1', '-z')).stdout

async function waitFor(predicate) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error('native failure/retry UI did not reach its expected state')
}
const wait = `(${waitFor.toString()})`
const checks = []
let moved = false
try {
  await evaluate(`(async () => {
    await window.__TAURI_INTERNALS__.invoke('workspace_select', {path:${JSON.stringify(repository)}});
    const click = label => [...document.querySelectorAll('aside button')].find(b => b.innerText.trim() === label).click();
    click('关于');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    click('设置');
    await ${wait}(() => [...document.querySelectorAll('button')].some(b => b.innerText === '审阅变更'));
    [...document.querySelectorAll('button')].find(b => b.innerText === '审阅变更').click();
    return ${wait}(() => document.querySelector('[role="dialog"] table'));
  })()`)
  await rename(join(repository, '.git'), join(repository, '.qa-disabled-git'))
  moved = true
  const failure = await evaluate(`(async () => {
    const dialog = document.querySelector('[role="dialog"]');
    const refresh = dialog.querySelector('[aria-label="重新检测"]');
    refresh.focus(); refresh.click();
    await ${wait}(() => dialog.querySelector('[role="alert"]'));
    return {error: Boolean(dialog.querySelector('[role="alert"]').innerText.trim()),
      retryEnabled: !refresh.disabled, focused: dialog.contains(document.activeElement),
      noStaleTable: !dialog.querySelector('table')};
  })()`)
  assert(
    failure.error && failure.retryEnabled && failure.noStaleTable,
    'native failure not clearly recoverable',
  )
  assert(failure.focused, 'focus escaped the dialog after native failure')
  checks.push('genuine missing-Git error replaces stale results and leaves retry/focus usable')
  await execute(
    process.execPath,
    [runner, port, 'screenshot', join(destination, 'worktree-native-error.png')],
    { windowsHide: true },
  )
  await rename(join(repository, '.qa-disabled-git'), join(repository, '.git'))
  moved = false
  const restored = await evaluate(`(async () => {
    const dialog = document.querySelector('[role="dialog"]');
    const refresh = dialog.querySelector('[aria-label="重新检测"]');
    refresh.focus(); refresh.click();
    await ${wait}(() => dialog.querySelector('table'));
    return {noError: !dialog.querySelector('[role="alert"]'), focused: dialog.contains(document.activeElement),
      changedFile: dialog.innerText.includes('tracked.txt')};
  })()`)
  assert(
    restored.noError && restored.focused && restored.changedFile,
    'retry did not fully recover',
  )
  checks.push('restoring Git and retrying returns the real changed-file table and clears the error')
} finally {
  if (moved) await rename(join(repository, '.qa-disabled-git'), join(repository, '.git'))
  await evaluate(`(async () => {
    document.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    await window.__TAURI_INTERNALS__.invoke('workspace_select', {path:${JSON.stringify(identity.workspace)}});
    [...document.querySelectorAll('aside button')].find(b=>b.innerText.trim()==='关于')?.click();
    return true;
  })()`)
}
assert.equal((await git('status', '--porcelain=v1', '-z')).stdout, before, 'Git state changed')
checks.push('original QA workspace restored and fixture Git/index state unchanged')
const result = { checks, repository, completed: new Date().toISOString() }
await writeFile(join(destination, 'worktree-failure.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

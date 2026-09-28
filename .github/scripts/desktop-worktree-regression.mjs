// Isolated Git fixtures, actual WebView ACL, and UI review. Never edits a user repository.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [qaHome, output, port = '9223'] = process.argv.slice(2)
if (!qaHome || !output)
  throw new Error('usage: desktop-worktree-regression.mjs QA_HOME OUTPUT [PORT]')
const destination = resolve(output)
await mkdir(destination, { recursive: true })
const repository = await mkdtemp(join(destination, 'review-'))
const execute = promisify(execFile)
const git = async (...args) => execute('git', ['-C', repository, ...args], { windowsHide: true })
await git('init', '-b', 'main')
await git('config', 'user.name', 'Desktop QA')
await git('config', 'user.email', 'qa@example.invalid')
await git('config', 'core.autocrlf', 'false')
await git('config', 'core.hooksPath', join(repository, 'disabled-hooks'))
await writeFile(join(repository, 'tracked.txt'), 'base\n')
await git('add', 'tracked.txt')
await git('-c', 'commit.gpgsign=false', 'commit', '-m', 'QA fixture')
await writeFile(join(repository, 'tracked.txt'), 'staged\n')
await git('add', 'tracked.txt')
await writeFile(join(repository, 'tracked.txt'), 'unstaged\n<script>not markup</script>\n')
await writeFile(join(repository, '未跟踪.txt'), 'This content must not appear in a diff.')
const before = (await git('status', '--porcelain=v1', '-z')).stdout

async function checkReview({ qaHome, repository }) {
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args)
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const normalize = (value) => value.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '')
  const profile = await invoke('plugin_state')
  assert(
    normalize(profile.profileDir).startsWith(`${normalize(qaHome)}/profiles/`),
    'not a QA profile',
  )
  assert(
    (await invoke('harness_status')).phase === 'stopped',
    'stop the QA Harness before changing workspace',
  )
  const previous = (await invoke('harness_environment')).workspace
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise((accept) => setTimeout(accept, 50))
    }
    throw new Error(`worktree acceptance timeout: ${label}`)
  }
  const click = (text, scope = document) => {
    const button = [...scope.querySelectorAll('button')].find(
      (item) => item.innerText.trim() === text,
    )
    assert(button && !button.disabled, `missing button: ${text}`)
    button.focus()
    button.click()
    return button
  }
  const checks = []
  try {
    await invoke('workspace_select', { path: repository })
    const trees = await invoke('workspace_worktrees')
    assert(trees.length === 1 && trees[0].dirty, 'dirty fixture worktree is missing')
    const review = await invoke('workspace_worktree_review', { path: repository })
    assert(review.changes.length === 2, 'native changed-file count')
    assert(review.staged.text.includes('+staged'), 'native staged diff')
    assert(review.unstaged.text.includes('+unstaged'), 'native unstaged diff')
    let rejected = false
    try {
      await invoke('workspace_worktree_review', { path: qaHome })
    } catch {
      rejected = true
    }
    assert(rejected, 'arbitrary unregistered directory accepted')
    checks.push('real review ACL, staged/unstaged distinction and foreign-directory rejection')

    click('关于', document.querySelector('aside'))
    await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)))
    click('设置', document.querySelector('aside'))
    await wait(
      () => [...document.querySelectorAll('button')].some((item) => item.innerText === '审阅变更'),
      'worktree list',
    )
    const opener = click('审阅变更')
    await wait(() => document.querySelector('[role="dialog"] table'), 'review file table')
    const dialog = document.querySelector('[role="dialog"]')
    const backdrop = dialog.parentElement.getBoundingClientRect()
    assert(
      backdrop.left === 0 && backdrop.top === 0 && Math.abs(backdrop.width - innerWidth) < 1,
      'review backdrop does not cover the full window',
    )
    assert(dialog.innerText.includes('未跟踪.txt'), 'untracked path is not visible')
    assert(
      dialog.innerText.includes('未暂存 · 1') && dialog.innerText.includes('已暂存 · 1'),
      'UI change counts',
    )
    assert(dialog.contains(document.activeElement), 'opening focus escaped the dialog')
    click('未暂存 · 1', dialog)
    await wait(
      () => dialog.querySelector('pre')?.innerText.includes('+unstaged'),
      'unstaged diff display',
    )
    assert(
      dialog.querySelector('pre').innerText.includes('<script>not markup</script>'),
      'diff text not preserved',
    )
    assert(dialog.querySelector('pre script') === null, 'diff content became HTML')
    click('已暂存 · 1', dialog)
    await wait(
      () => dialog.querySelector('pre')?.innerText.includes('+staged'),
      'staged diff display',
    )
    checks.push('file list, untracked paths, staged/unstaged views and plain-text diff rendering')

    dialog.querySelector('[aria-label="重新检测"]').click()
    // Let React commit the loading transition before observing completion;
    // otherwise the previous render can satisfy the predicate immediately.
    await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)))
    await wait(
      () => dialog.querySelector('[aria-busy="false"]') && dialog.querySelector('pre'),
      'refresh retains selected view',
    )
    assert(document.documentElement.scrollWidth <= innerWidth, 'review caused page overflow')
    const last = dialog.querySelector('[role="region"]')
    last.focus()
    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    )
    assert(document.activeElement === dialog.querySelector('button'), 'forward Tab focus trap')
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(() => !document.querySelector('[role="dialog"]'), 'Escape closes review')
    assert(document.activeElement === opener, 'opener focus was not restored')
    checks.push('refresh, keyboard focus trap, Escape dismissal and opener focus restoration')
  } finally {
    document
      .querySelector('[role="dialog"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await invoke('workspace_select', { path: previous })
    click('关于', document.querySelector('aside'))
  }
  return { checks, repository, completed: new Date().toISOString() }
}

const runner = join(dirname(fileURLToPath(import.meta.url)), 'desktop-ui-acceptance.mjs')
const { stdout } = await execute(
  process.execPath,
  [
    runner,
    port,
    'eval',
    `(${checkReview.toString()})(${JSON.stringify({ qaHome: resolve(qaHome), repository })})`,
  ],
  { timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
).catch((cause) => {
  throw new Error(cause.stderr || cause.message)
})
if ((await git('status', '--porcelain=v1', '-z')).stdout !== before)
  throw new Error('review changed Git state')
const result = JSON.parse(stdout)
result.checks.push('Git index and working-copy status unchanged after all review actions')
await writeFile(join(destination, 'worktree-review.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))

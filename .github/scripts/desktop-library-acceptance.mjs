// Acceptance through the actual isolated desktop's WebView and native IPC.
// The caller supplies its existing CDP connection; no browser profile is opened.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

export async function runLibraryAcceptance({ evaluate, command, qaHome, qaData, output }) {
  const normal = (path) => resolve(path).replaceAll('\\', '/').toLowerCase()
  const profile = await evaluate(
    "window.__TAURI_INTERNALS__.invoke('plugin_state').then(x=>x.profileDir)",
  )
  if (
    !normal(profile).startsWith(`${normal(qaHome)}/profiles/`) ||
    !normal(qaData).includes('-qa-')
  )
    throw new Error(
      'personal-library acceptance requires an isolated QA profile and data directory',
    )
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const wait = async (expression, message) => {
    const until = Date.now() + 30000
    while (Date.now() < until) {
      if (await evaluate(expression)) return
      await new Promise((accept) => setTimeout(accept, 40))
    }
    throw new Error(`personal-library timeout: ${message}`)
  }
  const click = async (expression) => {
    const point = await evaluate(
      `(()=>{const e=(${expression});if(!e||e.disabled)throw Error('control unavailable');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    })
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    })
  }
  const button = (label, scope = 'document') =>
    `[...${scope}.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`
  const field = (index) =>
    `document.querySelectorAll('[role=dialog] input,[role=dialog] textarea')[${index}]`
  const searchField = `[...document.querySelectorAll('input[type=search]')].find(e=>e.getClientRects().length)`
  const text = async (expression, value) => {
    await click(expression)
    await command('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    })
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    })
    await command('Input.insertText', { text: value })
  }
  const route = async (label) => {
    await click(button(label, "document.querySelector('aside')"))
    await wait(
      `[...document.querySelectorAll('h1,h2')].some(e=>e.getClientRects().length && e.textContent===${JSON.stringify(label)})`,
      label,
    )
  }
  const screenshot = async (name) => {
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    const shot = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, 'base64'))
  }
  const native = (name, args = {}) =>
    evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`)
  await mkdir(output, { recursive: true })
  const stamp = Date.now().toString(36)
  const id = `qa-library-${stamp}`
  const project = join(resolve(qaHome), 'qa-project')
  const sessionDir = join(resolve(qaHome), 'sessions', 'qa-library', id)
  await mkdir(project, { recursive: true })
  await mkdir(sessionDir, { recursive: true })
  const now = Date.now()
  const rows = [{ type: 'session', version: 0, id, createdAt: now, cwd: project }]
  for (let seq = 1; seq <= 3; seq++) {
    const message = {
      source: { kind: seq % 2 ? 'user' : 'assistant' },
      content: [{ type: 'text', text: `Fixture ${id} message ${seq}` }],
    }
    rows.push({
      type: seq % 2 ? 'user/message' : 'assistant/message',
      seq,
      time: now + seq,
      data: seq % 2 ? message : { message },
    })
  }
  await writeFile(
    join(sessionDir, 'session.jsonl.zstd'),
    zstdCompressSync(Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')),
  )
  const result = { id, checks: [], completed: null }
  const checked = (name) => result.checks.push(name)
  let promptId
  try {
    await route('提示库')
    await wait(`${button('新建提示')} && !(${button('新建提示')}).disabled`, 'library loaded')
    await click(button('新建提示'))
    await wait('Boolean(document.querySelector("[role=dialog] input"))', 'editor opened')
    await text(field(0), `QA 提示 ${stamp}`)
    await text(field(1), '请检查 {{文件}} 并说明 {{重点}}。保留 $& 字面值。')
    await text(field(2), Array.from({ length: 13 }, (_, index) => `标签${index}`).join(','))
    assert(
      await evaluate('document.querySelector("[role=dialog] button[type=submit]").disabled'),
      'overflow tags must block saving',
    )
    await text(field(2), '代码，质量,代码')
    await click(button('取消', 'document.querySelector("[role=dialog]")'))
    await wait('Boolean(document.querySelector("[role=alertdialog]"))', 'discard confirmation')
    await click(button('取消', 'document.querySelector("[role=alertdialog]")'))
    await wait('!document.querySelector("[role=alertdialog]")', 'discard canceled')
    assert(
      await evaluate(`(${field(0)}).value===${JSON.stringify(`QA 提示 ${stamp}`)}`),
      'cancel lost the edited title',
    )
    await screenshot(`prompt-editor-${stamp}`)
    await click('document.querySelector("[role=dialog] button[type=submit]")')
    await wait('!document.querySelector("[role=dialog]")', 'prompt saved')
    const saved = await native('library_read')
    const prompt = Object.values(saved.prompts).find((item) => item.title === `QA 提示 ${stamp}`)
    assert(
      prompt && prompt.tags.join(',') === '代码,质量',
      'native prompt snapshot did not match form',
    )
    promptId = prompt.id
    checked('prompt creation, tag bounds, deduplication, canceled discard, durable native save')
    await text(searchField, `QA 提示 ${stamp}`)
    await wait('document.querySelectorAll("article").length===1', 'filtered prompt')
    await click(button('复制指令'))
    await wait('document.querySelectorAll("[role=dialog] input").length===2', 'template fields')
    assert(
      await evaluate('document.querySelector("[role=dialog] button[type=submit]").disabled'),
      'empty variables enabled copying',
    )
    await text(field(0), 'src/main.ts')
    await text(field(1), '权限与失败处理')
    assert(
      await evaluate(
        'document.querySelector("[role=dialog] pre").textContent.includes("src/main.ts")',
      ),
      'template preview missing substitution',
    )
    await click('document.querySelector("[role=dialog] button[type=submit]")')
    await wait('!document.querySelector("[role=dialog]")', 'clipboard copy')
    const copied = await native('plugin:clipboard-manager|read_text')
    assert(
      copied.includes('src/main.ts') &&
        copied.includes('权限与失败处理') &&
        copied.includes('$&') &&
        !copied.includes('{{'),
      'clipboard substitution was not literal and complete',
    )
    checked('required template variables, preview, actual clipboard copy without sending')
    await command('Page.reload')
    await wait('Boolean(document.querySelector("aside"))', 'reload')
    await wait("document.body.innerText.includes('已就绪')", 'native inspection after reload')
    await evaluate('new Promise(r=>setTimeout(r,300))')
    await route('提示库')
    await wait(
      `document.body.innerText.includes(${JSON.stringify(`QA 提示 ${stamp}`)})`,
      'prompt persisted on reload',
    )
    await route('会话')
    await wait(
      'Boolean(document.querySelector("button[aria-label=重新查找会话]"))',
      'session refresh',
    )
    await wait(
      '!document.querySelector("button[aria-label=重新查找会话]").disabled',
      'session scan',
    )
    await click('document.querySelector("button[aria-label=重新查找会话]")')
    await wait(`document.body.innerText.includes(${JSON.stringify(id)})`, 'fixture listed')
    const row = `[...document.querySelectorAll('[role=button]')].find(e=>e.textContent.includes(${JSON.stringify(id)}))`
    await click(`(${row}).querySelector('button[aria-label=整理会话]')`)
    await text(field(0), `QA 会话 ${stamp}`)
    await text(field(1), '发布，检查')
    await text(field(2), '独立验证笔记')
    await click('document.querySelector("[role=dialog] button[type=submit]")')
    await wait('!document.querySelector("[role=dialog]")', 'annotation saved')
    const aliasRow = `[...document.querySelectorAll('[role=button]')].find(e=>e.textContent.includes(${JSON.stringify(`QA 会话 ${stamp}`)}))`
    await click(`(${aliasRow}).querySelector('button[aria-label=置顶会话]')`)
    await wait(
      `window.__TAURI_INTERNALS__.invoke('library_read').then(x=>x.sessions[${JSON.stringify(id)}]?.pinned)`,
      'pin persisted',
    )
    const pinned = await native('library_read')
    assert(
      pinned.sessions[id].pinned && pinned.sessions[id].note === '独立验证笔记',
      'pin overwrote note',
    )
    await text(searchField, '独立验证笔记')
    await wait(
      `document.body.innerText.includes(${JSON.stringify(`QA 会话 ${stamp}`)})`,
      'annotation search',
    )
    await text(searchField, '')
    await click(aliasRow)
    await wait('document.querySelectorAll("[data-seq]").length===3', 'transcript')
    await click(`document.querySelector('[data-seq="2"] button[aria-label=标记重要消息]')`)
    await wait(
      `Boolean(document.querySelector('[data-seq="2"] button[aria-label=取消消息标记]'))`,
      'bookmark saved',
    )
    await click(button('重要消息 · 1'))
    await wait('document.querySelectorAll("[data-seq]").length===1', 'bookmarks filter')
    assert(
      await evaluate(`Boolean(document.querySelector('[data-seq="2"]'))`),
      'wrong bookmarked message',
    )
    await screenshot(`session-bookmarks-${stamp}`)
    checked('session alias, tags, note search, pin partial merge, message bookmark filter')
    await route('工作区')
    await wait(`document.body.innerText.includes(${JSON.stringify(project)})`, 'workspace grouping')
    await text(searchField, 'qa-project')
    await wait('document.querySelectorAll("article").length===1', 'workspace filtering')
    await screenshot(`workspace-${stamp}`)
    await click(button('查看会话'))
    await wait(
      `[...document.querySelectorAll('h1,h2')].some(e=>e.getClientRects().length && e.textContent==='会话')`,
      'workspace session navigation',
    )
    assert(
      await evaluate(`document.body.innerText.includes(${JSON.stringify(`QA 会话 ${stamp}`)})`),
      'workspace route lost its sessions',
    )
    checked('workspace grouping, search, associated session navigation')
    const before = JSON.stringify(await native('library_read'))
    const invalid = await evaluate(
      `window.__TAURI_INTERNALS__.invoke('prompt_save',{prompt:{id:'invalid-${stamp}',title:'',body:'body',tags:[]}}).then(()=>false,()=>true)`,
    )
    assert(
      invalid && JSON.stringify(await native('library_read')) === before,
      'invalid prompt modified durable state',
    )
    const unknown = await evaluate(
      `window.__TAURI_INTERNALS__.invoke('session_annotate',{id:'missing-${stamp}',annotation:{pinned:true}}).then(()=>false,()=>true)`,
    )
    assert(unknown, 'nonexistent session accepted an annotation')
    const disk = JSON.parse(await readFile(join(qaData, 'personal-library.json'), 'utf8'))
    assert(
      disk.sessions[id].bookmarks.join(',') === '2' && disk.prompts[promptId],
      'disk state did not match IPC',
    )
    checked(
      'native ACL, invalid writes preserved data, nonexistent session rejection, disk persistence',
    )
    await route('提示库')
    await text(searchField, `QA 提示 ${stamp}`)
    await wait('document.querySelectorAll("article").length===1', 'prompt search')
    await click('document.querySelector("article button[aria-label=删除提示]")')
    await wait('Boolean(document.querySelector("[role=alertdialog]"))', 'delete confirmation')
    await click(button('取消', 'document.querySelector("[role=alertdialog]")'))
    assert(
      Boolean((await native('library_read')).prompts[promptId]),
      'canceled delete removed prompt',
    )
    await click('document.querySelector("article button[aria-label=删除提示]")')
    await wait('Boolean(document.querySelector("[role=alertdialog]"))', 'delete confirmation again')
    await click(button('删除提示', 'document.querySelector("[role=alertdialog]")'))
    await wait(`!document.querySelector('article')`, 'prompt removed')
    assert(!(await native('library_read')).prompts[promptId], 'confirmed deletion did not persist')
    checked('prompt search, canceled deletion, confirmed durable deletion')
    await native('session_annotate', {
      id,
      annotation: { title: '', pinned: false, tags: [], note: '', bookmarks: [] },
    })
    await rm(sessionDir, { recursive: true })
    result.completed = new Date().toISOString()
    await writeFile(join(output, `personal-library-${stamp}.json`), JSON.stringify(result, null, 2))
    return result
  } catch (error) {
    await screenshot(`failure-${stamp}`).catch(() => {})
    throw error
  }
}

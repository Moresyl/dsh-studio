// Actual isolated WebView input, native ACL and persistence. No browser profile is opened.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { DESKTOP_ROUTES } from './desktop-route-contract.mjs'

export async function runRouteAcceptance({ evaluate, command, qaHome, output }) {
  const profile = await evaluate("window.__TAURI_INTERNALS__.invoke('plugin_state')")
  assert(resolve(profile.profileDir).toLowerCase().startsWith(resolve(qaHome).toLowerCase()))
  const results = []
  for (const { label, heading } of DESKTOP_ROUTES) {
    const point = await evaluate(`(()=>{
      const e=[...document.querySelectorAll('aside button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});
      if(!e||e.disabled)throw Error('navigation unavailable');
      e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`)
    for (const type of ['mousePressed', 'mouseReleased'])
      await command('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
    const deadline = Date.now() + 30000
    let view
    do {
      view = await evaluate(
        `({ready:[...document.querySelectorAll('h1,h2')].some(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(heading)}),overflow:document.documentElement.scrollWidth>innerWidth,dialogs:document.querySelectorAll('[role=dialog],[role=alertdialog]').length})`,
      )
      if (view.ready) break
      await new Promise((accept) => setTimeout(accept, 40))
    } while (Date.now() < deadline)
    assert(view.ready && !view.overflow && view.dialogs === 0, `route ${label}`)
    results.push(label)
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'routes.json'), JSON.stringify(results, null, 2))
  return results
}

export async function runExpansionAcceptance({ evaluate, command, qaHome, qaData, output }) {
  const normal = (value) => resolve(value).replaceAll('\\', '/').toLowerCase()
  const native = (name, args = {}) =>
    evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`)
  const profile = await native('plugin_state')
  assert(
    normal(profile.profileDir).startsWith(`${normal(qaHome)}/profiles/`) &&
      normal(qaData).includes('-qa-'),
    'isolated QA data required',
  )
  await mkdir(output, { recursive: true })
  const result = { checks: [], completed: null }
  const wait = async (expression, label) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await new Promise((accept) => setTimeout(accept, 40))
    }
    throw new Error(`expansion acceptance timeout: ${label}`)
  }
  const click = async (expression) => {
    const point = await evaluate(
      `(()=>{const e=(${expression});if(!e||e.disabled)throw Error('unavailable control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    ).catch((cause) => {
      throw new Error(`Could not click ${expression}`, { cause })
    })
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
    await evaluate('new Promise(accept=>requestAnimationFrame(()=>requestAnimationFrame(accept)))')
  }
  const button = (label, root = 'document') =>
    `[...(${root}).querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(label)})`
  const route = async (label) => {
    await wait(`Boolean(${button(label, "document.querySelector('aside')")})`, 'sidebar ready')
    await click(button(label, "document.querySelector('aside')"))
    await wait(
      `[...document.querySelectorAll('h1,h2')].some(e=>e.getClientRects().length&&e.textContent===${JSON.stringify(label)})`,
      label,
    )
  }
  const text = async (expression, value) => {
    await click(expression)
    await command('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 2,
      windowsVirtualKeyCode: 65,
    })
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 2,
      windowsVirtualKeyCode: 65,
    })
    await command('Input.insertText', { text: value })
  }
  const choose = async (path) => {
    const document = await command('DOM.getDocument', {})
    const node = await command('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '[role=dialog] input[type=file]',
    })
    assert(node.nodeId, 'file input missing')
    await command('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] })
  }
  const screenshot = async (name) => {
    const shot = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, 'base64'))
  }
  const stamp = Date.now().toString(36)
  const ids = [0, 1, 2].map((index) => `qa-expansion-${stamp}-${index}`)
  const project = join(resolve(qaHome), 'qa-expansion-workspace')
  const sessionRoot = join(resolve(qaHome), 'sessions', 'qa-expansion')
  await mkdir(join(project, 'src'), { recursive: true })
  await writeFile(
    join(project, 'src', 'example.ts'),
    'export const hello = "你好"\n// Read-only fixture\n',
  )
  await writeFile(
    join(project, 'unsafe.html'),
    '<script>globalThis.qaUnexpectedExecution=true</script>',
  )
  await writeFile(join(project, 'binary.dat'), Buffer.from([0, 255]))
  for (const id of ids) {
    const directory = join(sessionRoot, id)
    await mkdir(directory, { recursive: true })
    const time = Date.now()
    const rows = [
      { type: 'session', version: 0, id, createdAt: time, cwd: project },
      {
        type: 'user/message',
        seq: 1,
        time,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: id }] },
      },
    ]
    await writeFile(
      join(directory, 'session.jsonl.zstd'),
      zstdCompressSync(Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')),
    )
  }
  const promptId = `qa-prompt-${stamp}`
  const addedId = `qa-added-${stamp}`
  try {
    await native('workspace_select', { path: project })
    await command('Page.reload', {})
    await wait('Boolean(document.querySelector("aside"))', 'desktop reload')
    await route('工作区')
    await click(button('浏览文件'))
    await wait(
      'document.querySelector("[role=dialog]")?.textContent.includes("unsafe.html")',
      'workspace listing',
    )
    await click(button('src'))
    await wait(
      'document.querySelector("[role=dialog]")?.textContent.includes("example.ts")',
      'lazy child directory',
    )
    await click(
      `[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.includes('example.ts'))`,
    )
    await wait(
      'document.querySelector("[role=dialog] pre")?.textContent.includes("你好")',
      'UTF-8 text preview',
    )
    await click(button('复制文本'))
    assert((await native('plugin:clipboard-manager|read_text')).includes('Read-only fixture'))
    await screenshot(`files-text-${stamp}`)
    await click('document.querySelector("button[aria-label=上级文件夹]")')
    await wait(
      'document.querySelector("[role=dialog]")?.textContent.includes("unsafe.html")',
      'parent navigation',
    )
    await click(
      `[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.includes('unsafe.html'))`,
    )
    await wait(
      'document.querySelector("[role=dialog] pre")?.textContent.includes("<script>")',
      'HTML displayed as text',
    )
    assert(!(await evaluate('globalThis.qaUnexpectedExecution')), 'preview executed HTML')
    await click(
      `[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.includes('binary.dat'))`,
    )
    await wait(
      'document.querySelector("[role=dialog] [role=alert]")?.textContent.includes("binary")',
      'binary rejected',
    )
    await text('document.querySelector("[role=dialog] input[type=search]")', 'missing')
    await wait(
      'document.querySelector("[role=dialog]")?.textContent.includes("没有匹配")',
      'empty filter',
    )
    await click('document.querySelector("[role=dialog] button[aria-label=关闭]")')
    for (const args of [
      { relative: '../private', expectedRoot: project },
      { relative: 'unsafe.html', expectedRoot: resolve(qaHome) },
    ]) {
      await assert.rejects(() => native('workspace_file_read', args))
    }
    result.checks.push(
      'current-workspace ACL, lazy folders, parent navigation, UTF-8 preview, clipboard, escaped HTML, binary rejection, filtering, traversal and stale-root denial',
    )

    await route('会话')
    await text(
      `[...document.querySelectorAll('input[type=search]')].find(e=>e.getClientRects().length)`,
      `qa-expansion-${stamp}`,
    )
    await wait(
      'document.querySelectorAll("input[type=checkbox]").length===0',
      'initial selection mode',
    )
    await wait(
      `[...document.querySelectorAll('[role=button]')].filter(e=>e.textContent.includes(${JSON.stringify(`qa-expansion-${stamp}`)})).length===3`,
      'all session fixtures',
    )
    await wait(
      'document.body.innerText.includes("1 行命中") && document.querySelectorAll("[role=button]").length===3',
      'debounced transcript search complete',
    )
    await click(button('选择会话'))
    await click(button('选择当前结果（最多 500 个）'))
    await wait(`Boolean(${button('已选 3 个')})`, 'selection rendered')
    await click(button('已选 3 个'))
    await click(button('批量置顶'))
    await wait('!document.querySelector("[role=dialog]")', 'batch pins saved')
    let state = await native('library_read')
    assert(
      ids.every((id) => state.sessions[id].pinned),
      'batch pin did not persist',
    )
    await click(button('选择当前结果（最多 500 个）'))
    await click(button('已选 3 个'))
    await text('document.querySelector("[role=dialog] input")', '发布，质量,发布')
    await click('document.querySelector("[role=dialog] button[type=submit]")')
    await wait('!document.querySelector("[role=dialog]")', 'batch tags saved')
    state = await native('library_read')
    assert(ids.every((id) => state.sessions[id].tags.join(',') === '发布,质量'))
    await click(button('选择当前结果（最多 500 个）'))
    await text(
      `[...document.querySelectorAll('input[type=search]')].find(e=>e.getClientRects().length)`,
      ids[0],
    )
    await wait(`(${button('已选 0 个')})?.disabled===true`, 'filter clears selection')
    await assert.rejects(() =>
      native('session_annotate_many', { ids: [ids[0], 'missing'], annotation: { pinned: false } }),
    )
    assert(
      (await native('library_read')).sessions[ids[0]].pinned,
      'failed batch partially changed data',
    )
    result.checks.push(
      'three-session selection, atomic pin and tag writes, tag deduplication, view-scoped selection and all-or-none missing-session rejection',
    )

    await native('prompt_save', {
      prompt: {
        id: promptId,
        title: `QA ${stamp}`,
        body: 'Keep existing body',
        tags: ['original'],
      },
    })
    const fullPath = join(output, `backup-${stamp}.json`)
    const promptsPath = join(output, `prompts-${stamp}.json`)
    await native('library_export_save', { path: fullPath, promptsOnly: false })
    await native('library_export_save', { path: promptsPath, promptsOnly: true })
    const backup = JSON.parse(await readFile(fullPath, 'utf8'))
    const portable = JSON.parse(await readFile(promptsPath, 'utf8'))
    assert(ids.every((id) => backup.data.sessions[id].pinned))
    assert(portable.promptsOnly && Object.keys(portable.data.sessions).length === 0)
    await assert.rejects(() =>
      native('library_export_save', {
        path: join(qaData, 'personal-library.json'),
        promptsOnly: true,
      }),
    )
    const incoming = {
      ...portable,
      data: {
        ...portable.data,
        prompts: {
          [promptId]: { ...portable.data.prompts[promptId], body: 'Imported replacement' },
          [addedId]: {
            id: addedId,
            title: `Added ${stamp}`,
            body: 'Imported new prompt',
            tags: [],
          },
        },
      },
    }
    const incomingPath = join(output, `incoming-${stamp}.json`)
    await writeFile(incomingPath, JSON.stringify(incoming))
    await route('提示库')
    await click(button('导入提示'))
    await choose(incomingPath)
    await wait(
      'document.querySelector("[role=dialog]")?.textContent.includes("2 条提示")',
      'import preview',
    )
    await click(button('取消', 'document.querySelector("[role=dialog]")'))
    assert(!(await native('library_read')).prompts[addedId], 'cancel imported data')
    await click(button('导入提示'))
    await choose(incomingPath)
    await wait(`!(${button('导入已预览的资料')})?.disabled`, 'review enabled')
    await screenshot(`import-review-${stamp}`)
    await click(button('导入已预览的资料'))
    await wait('!document.querySelector("[role=dialog]")', 'merge complete')
    state = await native('library_read')
    assert(state.prompts[addedId] && state.prompts[promptId].body === 'Keep existing body')
    await click(button('导入提示'))
    await choose(incomingPath)
    await wait(
      'Boolean(document.querySelector("[role=dialog] button[role=switch]"))',
      'replacement policy',
    )
    await click('document.querySelector("[role=dialog] button[role=switch]")')
    await click(button('导入已预览的资料'))
    await wait('!document.querySelector("[role=dialog]")', 'replace complete')
    assert((await native('library_read')).prompts[promptId].body === 'Imported replacement')
    await click(button('导入提示'))
    await choose(fullPath)
    await wait(
      'document.querySelector("[role=dialog] [role=alert]")?.textContent.includes("完整备份")',
      'prompt-only boundary',
    )
    await click(button('取消', 'document.querySelector("[role=dialog]")'))
    const source = await readFile(incomingPath, 'utf8')
    const preview = await native('library_import_preview', { source })
    await native('prompt_save', {
      prompt: { id: addedId, title: `Added ${stamp}`, body: 'Concurrent change', tags: [] },
    })
    await assert.rejects(() =>
      native('library_import_apply', {
        source,
        revision: preview.revision,
        sourceHash: preview.sourceHash,
        overwrite: true,
      }),
    )
    assert((await native('library_read')).prompts[addedId].body === 'Concurrent change')
    await route('设置')
    await click(button('恢复资料'))
    await choose(fullPath)
    await wait(
      'document.querySelector("[role=dialog]")?.textContent.includes("条会话资料")',
      'full backup preview',
    )
    await click(button('取消', 'document.querySelector("[role=dialog]")'))
    result.checks.push(
      'native full and prompt-only JSON exports, managed-file protection, file-input preview, canceled import, keep/replace policies, new-record merge, stale-preview protection and full-backup Settings entry',
    )
    result.completed = new Date().toISOString()
    await writeFile(join(output, `expansion-${stamp}.json`), JSON.stringify(result, null, 2))
    return result
  } catch (error) {
    await screenshot(`failure-${stamp}`).catch(() => {})
    throw error
  } finally {
    for (const id of [promptId, addedId]) await native('prompt_remove', { id }).catch(() => {})
    for (const id of ids) {
      await native('session_annotate', {
        id,
        annotation: { title: '', pinned: false, tags: [], note: '', bookmarks: [] },
      }).catch(() => {})
      await rm(join(sessionRoot, id), { recursive: true, force: true })
    }
  }
}

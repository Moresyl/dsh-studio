// Exercise real supervisor events alongside visible environment re-checks.
// Only isolated QA profiles are accepted; never sends a model request.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [qaHome, output, port = '9223'] = process.argv.slice(2)
assert(qaHome && output, 'usage: desktop-runtime-regression.mjs QA_HOME OUTPUT [PORT]')
const execute = promisify(execFile)
const runner = join(dirname(fileURLToPath(import.meta.url)), 'desktop-ui-acceptance.mjs')
async function evaluate(source) {
  const { stdout } = await execute(process.execPath, [runner, port, 'eval', source], {
    windowsHide: true,
    timeout: 120000,
  })
  return JSON.parse(stdout)
}
const normalize = (value) => resolve(value).replaceAll('\\', '/').toLowerCase()
const identity = await evaluate(`(async()=>({
  profile:(await window.__TAURI_INTERNALS__.invoke('plugin_state')).profileDir,
  phase:(await window.__TAURI_INTERNALS__.invoke('harness_status')).phase,
}))()`)
assert(normalize(identity.profile).startsWith(`${normalize(qaHome)}/profiles/`), 'not isolated QA')
assert(['ready', 'stopped'].includes(identity.phase), 'runtime is not idle')
await evaluate(`(()=>{
  const b=[...document.querySelectorAll('aside button')].find(b=>b.innerText.trim()==='运行状态');
  if(!b)throw new Error('runtime navigation missing');b.click();return true;
})()`)
const checks = []
async function verify(phase) {
  return evaluate(`(async()=>{
    const deadline=Date.now()+20000;
    while(Date.now()<deadline) {
      const native=await window.__TAURI_INTERNALS__.invoke('harness_status');
      const label=${JSON.stringify(phase === 'ready' ? '停止' : '启动 Harness')};
      const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.innerText.trim()===label);
      if(native.phase===${JSON.stringify(phase)}&&b&&!b.disabled) return {
        phase:native.phase,pid:native.phase==='ready'?native.pid:null,
        dialogs:document.querySelectorAll('[role=alertdialog]').length,
        overflow:document.documentElement.scrollWidth>innerWidth,
      };
      await new Promise(r=>setTimeout(r,50));
    }
    throw new Error('visible runtime state disagrees with supervisor');
  })()`)
}
try {
  for (let pass = 1; pass <= 3; pass++) {
    // The visible re-check begins before the real transition. Tests do not
    // replace the native bridge or manufacture its result timing.
    for (const [command, phase] of [
      ['harness_stop', 'stopped'],
      ['harness_start', 'ready'],
    ]) {
      await evaluate(`(async()=>{
        const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.innerText.trim()==='重新检测');
        if(!b||b.disabled)throw new Error('environment re-check unavailable');
        b.click();await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)});
        return true;
      })()`)
      const result = await verify(phase)
      assert.equal(result.dialogs, 0, 'unexpected runtime failure dialog')
      assert(!result.overflow, 'runtime page overflow')
      checks.push({ pass, ...result })
    }
  }
} finally {
  await evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(identity.phase === 'ready' ? 'harness_start' : 'harness_stop')}).then(()=>true)`,
  )
}
await mkdir(resolve(output), { recursive: true })
await writeFile(
  join(resolve(output), 'runtime-transitions.json'),
  JSON.stringify(
    {
      checks,
      completed: new Date().toISOString(),
    },
    null,
    2,
  ),
)
console.log(JSON.stringify(checks, null, 2))

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [baseConfig, fullConfig, liteHook, fullHook] = await Promise.all([
  readFile('src-tauri/tauri.conf.json', 'utf8').then(JSON.parse),
  readFile('src-tauri/tauri.full.conf.json', 'utf8').then(JSON.parse),
  readFile('src-tauri/windows/installer-hooks.nsh', 'utf8'),
  readFile('src-tauri/windows/installer-hooks-full.nsh', 'utf8'),
])

test('Lite upgrades replace stale web assets without deleting the offline payload', () => {
  assert.equal(baseConfig.bundle.windows.nsis.installerHooks, 'windows/installer-hooks.nsh')
  assert.match(liteHook, /!macro NSIS_HOOK_PREINSTALL/)
  assert.match(liteHook, /RMDir \/r "\$INSTDIR\\dist"/)
  assert.doesNotMatch(liteHook, /\$INSTDIR\\offline/)
})

test('Full upgrades replace every versioned package resource', () => {
  assert.equal(fullConfig.bundle.windows.nsis.installerHooks, 'windows/installer-hooks-full.nsh')
  assert.match(fullHook, /!macro NSIS_HOOK_PREINSTALL/)
  assert.match(fullHook, /RMDir \/r "\$INSTDIR\\dist"/)
  assert.match(fullHook, /RMDir \/r "\$INSTDIR\\offline"/)
})

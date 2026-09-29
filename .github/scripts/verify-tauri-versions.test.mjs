import assert from 'node:assert/strict'
import test from 'node:test'

import { validateTauriVersions, verifyTauriVersions } from './verify-tauri-versions.mjs'

const manifest = {
  dependencies: {
    '@tauri-apps/api': '~2.11.1',
    '@tauri-apps/plugin-dialog': '~2.7.3',
    '@tauri-apps/plugin-process': '~2.3.1',
  },
  devDependencies: { '@tauri-apps/cli': '~2.11.4' },
}
const installed = {
  '@tauri-apps/api': '2.11.1',
  '@tauri-apps/cli': '2.11.4',
  '@tauri-apps/plugin-dialog': '2.7.3',
  '@tauri-apps/plugin-process': '2.3.1',
}
const lock = (processVersion = '2.3.1') => `
[[package]]
name = "tauri"
version = "2.11.5"

[[package]]
name = "tauri-plugin-dialog"
version = "2.7.2"

[[package]]
name = "tauri-plugin-process"
version = "${processVersion}"
`

test('Tauri guest bindings may differ by patch but not by minor version', () => {
  assert.deepEqual(validateTauriVersions(manifest, installed, lock()), [
    { guest: '@tauri-apps/api', installed: '2.11.1', native: 'tauri', nativeVersion: '2.11.5' },
    { guest: '@tauri-apps/cli', installed: '2.11.4', native: 'tauri', nativeVersion: '2.11.5' },
    {
      guest: '@tauri-apps/plugin-dialog',
      installed: '2.7.3',
      native: 'tauri-plugin-dialog',
      nativeVersion: '2.7.2',
    },
    {
      guest: '@tauri-apps/plugin-process',
      installed: '2.3.1',
      native: 'tauri-plugin-process',
      nativeVersion: '2.3.1',
    },
  ])
})

test('minor drift, floating ranges and missing native packages fail closed', () => {
  assert.throws(() => validateTauriVersions(manifest, installed, lock('2.4.0')), /does not match/)
  assert.throws(
    () =>
      validateTauriVersions(
        { ...manifest, dependencies: { ...manifest.dependencies, '@tauri-apps/api': '^2.11.1' } },
        installed,
        lock(),
      ),
    /patch-only/,
  )
  assert.throws(
    () =>
      validateTauriVersions(
        { ...manifest, dependencies: { ...manifest.dependencies, '@tauri-apps/api': '~2.11.2' } },
        installed,
        lock(),
      ),
    /does not admit/,
  )
  assert.throws(
    () =>
      validateTauriVersions(manifest, installed, lock().replace('tauri-plugin-dialog', 'other')),
    /must resolve exactly once/,
  )
  assert.throws(
    () => validateTauriVersions(manifest, installed, `${lock()}${lock()}`),
    /must resolve exactly once/,
  )
})

test('repository Tauri JavaScript and native packages stay compatible', async () => {
  assert.equal((await verifyTauriVersions()).length, 7)
})

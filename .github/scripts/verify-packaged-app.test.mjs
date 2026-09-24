import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'

import {
  resolveBundleRoot,
  rpmExtractArgs,
  shouldExerciseWindowsInstaller,
  waitUntilRemoved,
} from './verify-packaged-app.mjs'

test('resolves the bundle root before smoke tests change their working directory', () => {
  const root = resolveBundleRoot('src-tauri/target/release/bundle')
  assert.equal(root, resolve('src-tauri/target/release/bundle'))
  assert.equal(isAbsolute(root), true)
})

test('rejects a missing bundle root', () => {
  assert.throws(() => resolveBundleRoot(), /usage:/)
})

test('passes RPM paths with spaces directly to libarchive', () => {
  assert.deepEqual(rpmExtractArgs('/tmp/bundle/DSH Studio.rpm', '/tmp/rpm output'), [
    '-xf',
    '/tmp/bundle/DSH Studio.rpm',
    '-C',
    '/tmp/rpm output',
  ])
})

test('rejects incomplete RPM extraction arguments', () => {
  assert.throws(() => rpmExtractArgs('', '/tmp/rpm'), /required/)
  assert.throws(() => rpmExtractArgs('/tmp/app.rpm', ''), /required/)
})

test('keeps stateful Windows installer smoke tests on ephemeral CI by default', () => {
  assert.equal(shouldExerciseWindowsInstaller({}), false)
  assert.equal(shouldExerciseWindowsInstaller({ GITHUB_ACTIONS: 'true' }), true)
})

test('requires an explicit opt-in for a local stateful Windows installer smoke test', () => {
  assert.equal(shouldExerciseWindowsInstaller({ DSH_ALLOW_LOCAL_INSTALLER_SMOKE: '1' }), true)
  assert.equal(shouldExerciseWindowsInstaller({ DSH_ALLOW_LOCAL_INSTALLER_SMOKE: '0' }), false)
})

test('waits for an asynchronous Windows uninstaller to remove its directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-uninstall-wait-'))
  const removal = new Promise((resolveRemoval) =>
    setTimeout(() => resolveRemoval(rm(root, { recursive: true, force: true })), 20),
  )
  await waitUntilRemoved(root, { attempts: 20, intervalMs: 5 })
  await removal
})

test('fails when a Windows uninstaller leaves its directory behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-uninstall-timeout-'))
  try {
    await assert.rejects(
      waitUntilRemoved(root, { attempts: 2, intervalMs: 1 }),
      /silent uninstall did not remove/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

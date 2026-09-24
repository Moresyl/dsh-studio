import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'

import {
  finalizeWindowsUninstall,
  resolveBundleRoot,
  rpmExtractArgs,
  shouldExerciseWindowsInstaller,
  windowsUninstallerArgs,
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

test('keeps the NSIS uninstall root as the final unquoted argument', () => {
  const root = join(tmpdir(), 'DSH Studio package smoke')
  assert.deepEqual(windowsUninstallerArgs(root), ['/S', `_?=${resolve(root)}`])
})

test('rejects a missing Windows uninstall root', () => {
  assert.throws(() => windowsUninstallerArgs(), /root is required/)
})

test('removes the synchronous NSIS uninstaller and empty install tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-uninstall-complete-'))
  const uninstaller = join(root, 'uninstall.exe')
  await writeFile(uninstaller, 'fixture')
  await mkdir(join(root, 'empty-directory'))
  await finalizeWindowsUninstall(root, uninstaller)
  await assert.rejects(access(root), { code: 'ENOENT' })
})

test('reports packaged files left by a Windows uninstaller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-uninstall-residue-'))
  const uninstaller = join(root, 'uninstall.exe')
  await writeFile(uninstaller, 'fixture')
  await writeFile(join(root, 'DSH Studio.exe'), 'fixture')
  try {
    await assert.rejects(
      finalizeWindowsUninstall(root, uninstaller),
      /silent uninstall left packaged files.*DSH Studio\.exe/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

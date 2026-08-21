import assert from 'node:assert/strict'
import { isAbsolute, resolve } from 'node:path'
import test from 'node:test'

import { resolveBundleRoot, rpmExtractArgs } from './verify-packaged-app.mjs'

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

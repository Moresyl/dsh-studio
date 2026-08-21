import assert from 'node:assert/strict'
import { isAbsolute, resolve } from 'node:path'
import test from 'node:test'

import { resolveBundleRoot } from './verify-packaged-app.mjs'

test('resolves the bundle root before smoke tests change their working directory', () => {
  const root = resolveBundleRoot('src-tauri/target/release/bundle')
  assert.equal(root, resolve('src-tauri/target/release/bundle'))
  assert.equal(isAbsolute(root), true)
})

test('rejects a missing bundle root', () => {
  assert.throws(() => resolveBundleRoot(), /usage:/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HARNESS_PACKAGE,
  HARNESS_VERSION,
  NODE_VERSION,
  targetPlan,
} from './prepare-offline-runtime.mjs'

test('every release target maps to its exact native Node archive', () => {
  assert.deepEqual(targetPlan('x86_64-pc-windows-msvc'), {
    os: 'windows',
    arch: 'x86_64',
    nodeArchive: `node-v${NODE_VERSION}-win-x64.zip`,
  })
  assert.deepEqual(targetPlan('aarch64-apple-darwin'), {
    os: 'macos',
    arch: 'aarch64',
    nodeArchive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
  })
  assert.equal(HARNESS_PACKAGE, '@deepseek-ai/dsh')
  assert.equal(HARNESS_VERSION, '0.1.0-rc.8')
})

test('an unsupported target fails closed', () => {
  assert.throws(() => targetPlan('armv7-unknown-linux-gnueabihf'), /does not support/)
})

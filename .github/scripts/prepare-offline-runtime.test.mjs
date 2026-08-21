import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HARNESS_PACKAGE,
  HARNESS_VERSION,
  NODE_VERSION,
  PNPM_VERSION,
  requireExactVersion,
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
  assert.equal(PNPM_VERSION, '11.7.0')
})

test('an unsupported target fails closed', () => {
  assert.throws(() => targetPlan('armv7-unknown-linux-gnueabihf'), /does not support/)
})

test('the offline package manager must execute as the pinned version', () => {
  assert.doesNotThrow(() => requireExactVersion('11.7.0', PNPM_VERSION, 'offline pnpm'))
  assert.throws(
    () => requireExactVersion('10.30.2', PNPM_VERSION, 'offline pnpm'),
    /resolved 10\.30\.2, expected 11\.7\.0/,
  )
})

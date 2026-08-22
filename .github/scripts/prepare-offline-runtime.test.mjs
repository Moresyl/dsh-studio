import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'

import {
  HARNESS_PACKAGE,
  HARNESS_VERSION,
  NODE_VERSION,
  PNPM_VERSION,
  copyRuntimeContract,
  offlineNpmCiArgs,
  requireExactVersion,
  tarCreatePlan,
  tarCommand,
  tarExtractPlan,
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
  assert.equal(HARNESS_VERSION, '0.1.1-rc.2')
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

test('offline install materializes the bundled Studio integration', () => {
  const prefix = resolve('scratch', 'harness')
  assert.deepEqual(offlineNpmCiArgs(prefix), [
    'ci',
    '--prefix',
    prefix,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts=false',
    '--legacy-peer-deps',
    '--install-links',
  ])
})

test('tar archive creation never passes an absolute output path', () => {
  const archive = resolve('runtime-cache', 'offline', 'harness.tar.gz')
  const source = resolve('scratch', 'harness')
  assert.deepEqual(tarCreatePlan(archive, source), {
    cwd: dirname(archive),
    args: ['-czf', basename(archive), '-C', source, '.'],
  })
})

test('tar extraction never passes an absolute archive path', () => {
  const archive = resolve('runtime-cache', 'offline', 'node.zip')
  const destination = resolve('scratch', 'node-toolchain')
  assert.deepEqual(tarExtractPlan(archive, destination), {
    cwd: dirname(archive),
    args: ['-xf', basename(archive), '-C', destination],
  })
})

test('Windows ZIP extraction uses native bsdtar instead of Git Bash GNU tar', () => {
  assert.equal(
    tarCommand({ os: 'windows' }, { SystemRoot: 'C:\\Windows' }),
    join('C:\\Windows', 'System32', 'tar.exe'),
  )
  assert.equal(tarCommand({ os: 'linux' }, {}), 'tar')
  assert.throws(() => tarCommand({ os: 'windows' }, {}), /requires SystemRoot or WINDIR/)
})

test('copies the local integration package into the offline install context', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-studio-runtime-contract-test-'))
  const destination = join(scratch, 'harness')
  try {
    await mkdir(destination)
    await copyRuntimeContract(destination)
    await access(join(destination, 'package-lock.json'))
    const integration = JSON.parse(
      await readFile(join(destination, 'dsh-studio-integration', 'package.json'), 'utf8'),
    )
    assert.equal(integration.name, '@moresyl/dsh-studio-integration')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

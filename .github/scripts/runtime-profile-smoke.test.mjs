import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  isCleanAuthenticationRedirect,
  missingApplicationModules,
  parseReadyOrigin,
  prepareSmokeProfile,
  REQUIRED_APPLICATION_MODULES,
  verifyProfileBoot,
} from './runtime-profile-smoke.mjs'

test('readiness accepts only an explicit loopback HTTP port', () => {
  assert.equal(parseReadyOrigin('ordinary output'), undefined)
  assert.equal(
    parseReadyOrigin('dsh web: http://127.0.0.1:52175 (LAN: http://192.0.2.1:52175)'),
    'http://127.0.0.1:52175',
  )
  assert.equal(parseReadyOrigin('dsh web: http://localhost:3080/'), 'http://localhost:3080')
  assert.equal(
    parseReadyOrigin('dsh web: http://127.0.0.1:3080/ignored?token=abc_def&redirect=elsewhere'),
    'http://127.0.0.1:3080/?token=abc_def',
  )
})

test('readiness rejects malformed, remote, secure, and implicit-port origins', () => {
  for (const line of [
    'dsh web: not-a-url',
    'dsh web: http://example.com:3080',
    'dsh web: https://127.0.0.1:3080',
    'dsh web: http://127.0.0.1',
  ]) {
    assert.throws(() => parseReadyOrigin(line), /announced/)
  }
})

test('authentication redirect accepts clean equivalent roots only', () => {
  const request = 'http://127.0.0.1:3080/?token=secret'
  assert.equal(isCleanAuthenticationRedirect(request, '/'), true)
  assert.equal(isCleanAuthenticationRedirect(request, './'), true)
  assert.equal(isCleanAuthenticationRedirect(request, '/?token=secret'), false)
  assert.equal(isCleanAuthenticationRedirect(request, '/#fragment'), false)
  assert.equal(isCleanAuthenticationRedirect(request, 'http://localhost:3080/'), false)
  assert.equal(isCleanAuthenticationRedirect(request, null), false)
  assert.equal(isCleanAuthenticationRedirect(request, 'http://['), false)
})

test('application document must expose every qualified current-runtime surface', () => {
  const complete = REQUIRED_APPLICATION_MODULES.map(
    (module) => `<script src="/${module}"></script>`,
  ).join('')
  assert.deepEqual(missingApplicationModules(complete), [])
  assert.deepEqual(
    missingApplicationModules(complete.replace('@deepseek-ai/dsh-client-ui-jobs', 'missing-jobs')),
    ['@deepseek-ai/dsh-client-ui-jobs'],
  )
})

test('smoke profile mirrors the product bootstrap and materializes integration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-smoke-test-'))
  try {
    const runtime = join(root, 'runtime')
    const integration = join(runtime, 'node_modules', '@moresyl', 'dsh-studio-integration')
    await mkdir(join(integration, 'lib'), { recursive: true })
    await Promise.all(
      [
        'package.json',
        'cordis.patch.yml',
        'lib/index.js',
        'lib/file-preview.js',
        'lib/client.js',
        'lib/runtime-resolver.cjs',
      ].map(async (relative) => {
        const target = join(integration, relative)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, relative)
      }),
    )
    const home = join(root, 'home')
    const made = await prepareSmokeProfile(runtime, home)
    const manifest = JSON.parse(await readFile(join(made.profile, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])
    assert.equal(
      await readFile(
        join(
          home,
          'profiles',
          'node_modules',
          '@moresyl',
          'dsh-studio-integration',
          'lib',
          'client.js',
        ),
        'utf8',
      ),
      'lib/client.js',
    )
    const probe = await readFile(
      join(
        home,
        'profiles',
        'node_modules',
        '@moresyl',
        'dsh-studio-host-contract-probe',
        'index.js',
      ),
      'utf8',
    )
    assert.match(probe, /inject = \['dshStudioHost'\]/)
    assert.match(await readFile(made.probePatch, 'utf8'), /dsh-studio-host-contract-probe/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a silent startup identifies the entered Node phase and times out without claiming readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-silent-startup-test-'))
  try {
    const runtime = join(root, 'runtime')
    const integration = join(runtime, 'node_modules', '@moresyl', 'dsh-studio-integration')
    await mkdir(join(integration, 'lib'), { recursive: true })
    for (const relative of [
      'package.json',
      'cordis.patch.yml',
      'lib/index.js',
      'lib/file-preview.js',
      'lib/client.js',
      'lib/runtime-resolver.cjs',
    ]) {
      await writeFile(join(integration, relative), relative === 'package.json' ? '{}' : '')
    }
    const entry = join(runtime, 'silent.mjs')
    await writeFile(entry, 'setInterval(() => {}, 1000)\n')
    const progress = []
    await assert.rejects(
      verifyProfileBoot({
        entry,
        runtimeRoot: runtime,
        dshHome: join(root, 'home'),
        studioVersion: 'test',
        harnessVersion: 'test',
        timeout: 1500,
        onProgress: (stream, line) => progress.push({ stream, line }),
      }),
      (error) => {
        assert.match(error.message, /did not announce a port within 1500 ms/)
        assert.match(error.message, /entered Node; waiting for Harness readiness/)
        assert.match(error.message, /Node v\d+/)
        assert(!error.message.includes(root))
        return true
      },
    )
    assert(progress.some((entry) => entry.line.includes('Node entered managed startup')))
    assert(progress.some((entry) => entry.stream === 'status'))
    await writeFile(
      entry,
      "console.error('http://127.0.0.1:1234/?token=private-test-secret'); console.error('x'.repeat(10000)); process.exitCode=5\n",
    )
    const failedProgress = []
    await assert.rejects(
      verifyProfileBoot({
        entry,
        runtimeRoot: runtime,
        dshHome: join(root, 'failed-home'),
        studioVersion: 'test',
        harnessVersion: 'test',
        timeout: 1500,
        onProgress: (stream, line) => failedProgress.push({ stream, line }),
      }),
      (error) => {
        assert.match(error.message, /closed before readiness with 5/)
        assert(!error.message.includes('private-test-secret'))
        return true
      },
    )
    assert(failedProgress.some((entry) => entry.line.includes('[redacted]')))
    assert(
      failedProgress.every(
        (entry) => entry.line.length <= 4096 && !entry.line.includes('private-test-secret'),
      ),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

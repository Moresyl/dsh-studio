import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseReadyOrigin, prepareSmokeProfile } from './runtime-profile-smoke.mjs'

test('readiness accepts only an explicit loopback HTTP port', () => {
  assert.equal(parseReadyOrigin('ordinary output'), undefined)
  assert.equal(
    parseReadyOrigin('dsh web: http://127.0.0.1:52175 (LAN: http://192.0.2.1:52175)'),
    'http://127.0.0.1:52175',
  )
  assert.equal(parseReadyOrigin('dsh web: http://localhost:3080/'), 'http://localhost:3080')
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

test('smoke profile mirrors the product bootstrap and materializes integration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-smoke-test-'))
  try {
    const runtime = join(root, 'runtime')
    const integration = join(runtime, 'node_modules', '@moresyl', 'dsh-studio-integration')
    await mkdir(join(integration, 'lib'), { recursive: true })
    await Promise.all(
      ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js'].map(
        async (relative) => {
          const target = join(integration, relative)
          await mkdir(join(target, '..'), { recursive: true })
          await writeFile(target, relative)
        },
      ),
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

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DSH_STUDIO_HOST_PROTOCOL,
  apply,
  createStudioHostService,
} from '../../src-tauri/runtime-contract/dsh-studio-integration/lib/index.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-host-service-'))
  const profiles = join(root, 'profiles')
  const web = join(profiles, 'web')
  const research = join(profiles, 'research')
  const waiting = join(profiles, 'waiting')
  await Promise.all([
    mkdir(web, { recursive: true }),
    mkdir(research, { recursive: true }),
    mkdir(waiting, { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      join(web, 'package.json'),
      JSON.stringify({
        dependencies: { '@example/plugin': '1.2.3' },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
          },
        },
      }),
    ),
    writeFile(join(research, 'package.json'), '{not json'),
  ])
  return { root, profiles, web }
}

function environment(web) {
  return {
    DSH_STUDIO_PROFILE: 'web',
    DSH_STUDIO_PROFILE_DIR: web,
    DSH_STUDIO_VERSION: '0.8.0',
    DSH_STUDIO_RUNTIME_VERSION: '0.1.1-rc.2',
  }
}

test('Host service exposes frozen read-only runtime and bounded profile facts', async () => {
  const made = await fixture()
  try {
    const lifetime = createStudioHostService(environment(made.web))
    const host = lifetime.service
    assert.equal(host.protocol, DSH_STUDIO_HOST_PROTOCOL)
    assert.deepEqual(host.capabilities, ['profiles.read', 'runtime.read'])
    assert.deepEqual(host.restrictions, {
      arbitraryCommands: false,
      nativeHandles: false,
      packageMutation: false,
      profileMutation: false,
    })
    assert(Object.isFrozen(host))
    assert(Object.isFrozen(host.profiles.current))

    const roster = host.profiles.list()
    assert.deepEqual(
      roster.map((profile) => profile.name),
      ['research', 'waiting', 'web'],
    )
    assert.deepEqual(
      roster.find((profile) => profile.name === 'web'),
      {
        name: 'web',
        dir: made.web,
        initialized: true,
        servesWindow: true,
        packages: 1,
        problem: null,
      },
    )
    assert.equal(roster.find((profile) => profile.name === 'waiting').initialized, false)
    assert.equal(
      roster.find((profile) => profile.name === 'research').problem,
      'unreadable-manifest',
    )

    lifetime.dispose()
    assert.throws(() => host.profiles.list(), /generation is closed/)
  } finally {
    await rm(made.root, { recursive: true, force: true })
  }
})

test('Host service rejects forged and unsafe generation identities', async () => {
  const made = await fixture()
  try {
    assert.throws(
      () => createStudioHostService({ ...environment(made.web), DSH_STUDIO_PROFILE: '../web' }),
      /profile name is invalid/,
    )
    assert.throws(
      () => createStudioHostService({ ...environment(made.web), DSH_STUDIO_PROFILE: 'other' }),
      /identity does not match/,
    )
    assert.throws(
      () => createStudioHostService({ ...environment(made.web), DSH_STUDIO_PROFILE_DIR: 'web' }),
      /must be absolute/,
    )
  } finally {
    await rm(made.root, { recursive: true, force: true })
  }
})

test('Host service skips symlink aliases and fails clearly at its roster bound', async (t) => {
  const made = await fixture()
  try {
    const alias = join(made.profiles, 'alias')
    try {
      await symlink(made.web, alias, 'dir')
    } catch (cause) {
      if (process.platform === 'win32' && cause?.code === 'EPERM') {
        t.diagnostic('symlink creation is unavailable for this Windows account')
      } else {
        throw cause
      }
    }
    const host = createStudioHostService(environment(made.web)).service
    assert(!host.profiles.list().some((profile) => profile.name === 'alias'))

    await Promise.all(
      Array.from({ length: 126 }, (_, index) =>
        mkdir(join(made.profiles, `overflow-${String(index).padStart(3, '0')}`)),
      ),
    )
    assert.throws(() => host.profiles.list(), /128-profile safety limit/)
  } finally {
    await rm(made.root, { recursive: true, force: true })
  }
})

test('Cordis adapter publishes once and closes retained references with its fiber', async () => {
  const made = await fixture()
  const original = process.env
  process.env = { ...original, ...environment(made.web) }
  try {
    let host
    let close
    const ctx = {
      provide(name, value) {
        assert.equal(name, 'dshStudioHost')
        host = value
        return () => {}
      },
      effect(factory, label) {
        assert.equal(label, 'dsh-studio: Host service lifetime')
        close = factory()
      },
    }
    apply(ctx)
    assert.equal(host.profiles.current.name, 'web')
    close()
    assert.throws(() => host.profiles.list(), /generation is closed/)
  } finally {
    process.env = original
    await rm(made.root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const resolverSource = join(
  import.meta.dirname,
  '..',
  '..',
  'src-tauri',
  'runtime-contract',
  'dsh-studio-integration',
  'lib',
  'runtime-resolver.cjs',
)

async function writePackage(root, name, marker) {
  const directory = join(root, 'node_modules', ...name.split('/'))
  await mkdir(directory, { recursive: true })
  await Promise.all([
    writeFile(
      join(directory, 'package.json'),
      `${JSON.stringify({ name, version: '0.0.0', type: 'module', exports: './index.js' })}\n`,
    ),
    writeFile(join(directory, 'index.js'), `export default ${JSON.stringify(marker)}\n`),
  ])
}

function runFixture(resolver, entry) {
  return spawnSync(process.execPath, ['--require', resolver, entry], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

test('runtime resolver falls back only to managed official Harness packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-runtime-resolver-'))
  try {
    const managed = join(root, 'managed')
    const resolver = join(
      managed,
      'node_modules',
      '@moresyl',
      'dsh-studio-integration',
      'lib',
      'runtime-resolver.cjs',
    )
    await mkdir(dirname(resolver), { recursive: true })
    await copyFile(resolverSource, resolver)
    await writePackage(managed, '@deepseek-ai/dsh-resolver-fixture', 'managed')
    await writePackage(managed, 'third-party-resolver-fixture', 'must-not-load')

    const profile = join(root, 'home', 'profiles', 'web')
    await mkdir(profile, { recursive: true })
    const officialEntry = join(profile, 'official.mjs')
    await writeFile(
      officialEntry,
      "import marker from '@deepseek-ai/dsh-resolver-fixture'; console.log(marker)\n",
    )
    const official = runFixture(resolver, officialEntry)
    assert.equal(official.status, 0, official.stderr)
    assert.equal(official.stdout.trim(), 'managed')

    const thirdPartyEntry = join(profile, 'third-party.mjs')
    await writeFile(thirdPartyEntry, "import 'third-party-resolver-fixture'\n")
    const thirdParty = runFixture(resolver, thirdPartyEntry)
    assert.notEqual(thirdParty.status, 0)
    assert.match(thirdParty.stderr, /Cannot find package 'third-party-resolver-fixture'/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime resolver preserves a Profile-installed official package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-studio-runtime-resolver-priority-'))
  try {
    const managed = join(root, 'managed')
    const resolver = join(
      managed,
      'node_modules',
      '@moresyl',
      'dsh-studio-integration',
      'lib',
      'runtime-resolver.cjs',
    )
    await mkdir(dirname(resolver), { recursive: true })
    await copyFile(resolverSource, resolver)
    await writePackage(managed, '@deepseek-ai/dsh-resolver-fixture', 'managed')

    const profile = join(root, 'home', 'profiles', 'web')
    await writePackage(profile, '@deepseek-ai/dsh-resolver-fixture', 'profile')
    const entry = join(profile, 'entry.mjs')
    await writeFile(
      entry,
      "import marker from '@deepseek-ai/dsh-resolver-fixture'; console.log(marker)\n",
    )
    const loaded = runFixture(resolver, entry)
    assert.equal(loaded.status, 0, loaded.stderr)
    assert.equal(loaded.stdout.trim(), 'profile')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

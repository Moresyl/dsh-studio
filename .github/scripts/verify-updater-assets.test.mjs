import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyUpdaterAssets } from './verify-updater-assets.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-updater-assets-'))
  const version = '0.9.19'
  const repository = 'Moresyl/dsh-studio'
  const release = { tag_name: `v${version}`, assets: [] }
  const manifest = { version, platforms: {} }
  try {
    for (const [platform, name] of [
      ['windows-x86_64', 'DSH.Studio_0.9.19_x64-setup.exe'],
      ['linux-x86_64', 'DSH.Studio_0.9.19_amd64.AppImage'],
      ['darwin-aarch64', 'DSH.Studio_aarch64.app.tar.gz'],
      ['darwin-x86_64', 'DSH.Studio_x64.app.tar.gz'],
    ]) {
      const id = release.assets.length + 1
      const signature = `fixture-signature-${platform}`
      release.assets.push(
        { id, name, size: 5 },
        { id: id + 1, name: `${name}.sig`, size: signature.length },
      )
      manifest.platforms[platform] = {
        url: `https://api.github.com/repos/${repository}/releases/assets/${id}`,
        signature,
      }
      await writeFile(join(root, name), 'bytes')
      await writeFile(join(root, `${name}.sig`), `${signature}\n`)
    }
    const verify = async () => {
      await writeFile(join(root, 'latest.json'), JSON.stringify(manifest))
      return verifyUpdaterAssets(root, release, version, repository)
    }
    await run({ root, release, manifest, verify })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('binds all base platforms and alias entries to actual downloaded assets', async () => {
  await fixture(async ({ manifest, verify }) => {
    manifest.platforms['windows-x86_64-nsis'] = { ...manifest.platforms['windows-x86_64'] }
    assert.deepEqual(await verify(), { platforms: 5, artifacts: 4 })
  })
})

test('accepts version-pinned public download URLs as well as draft API URLs', async () => {
  await fixture(async ({ manifest, verify }) => {
    manifest.platforms['windows-x86_64'].url =
      'https://github.com/Moresyl/dsh-studio/releases/download/v0.9.19/DSH.Studio_0.9.19_x64-setup.exe'
    assert.equal((await verify()).artifacts, 4)
  })
})

test('rejects old manifest versions and release tag mismatches', async () => {
  await fixture(async ({ manifest, release, verify }) => {
    manifest.version = '0.9.18'
    await assert.rejects(verify(), /manifest version mismatch/)
    manifest.version = '0.9.19'
    release.tag_name = 'v0.9.18'
    await assert.rejects(verify(), /release\/tag version mismatch/)
  })
})

test('requires every supported base platform, not merely four arbitrary aliases', async () => {
  await fixture(async ({ manifest, verify }) => {
    manifest.platforms['windows-x86_64-nsis'] = manifest.platforms['windows-x86_64']
    delete manifest.platforms['darwin-aarch64']
    await assert.rejects(verify(), /missing a required platform/)
  })
})

test('rejects external, other-release and insecure download addresses', async () => {
  await fixture(async ({ manifest, verify }) => {
    for (const url of [
      'https://example.invalid/app.exe',
      'https://api.github.com/repos/Moresyl/dsh-studio/releases/assets/999',
      'http://api.github.com/repos/Moresyl/dsh-studio/releases/assets/1',
    ]) {
      manifest.platforms['windows-x86_64'].url = url
      await assert.rejects(verify(), /not an asset of this release/)
    }
  })
})

test('rejects inline signatures that do not match the uploaded signature file', async () => {
  await fixture(async ({ manifest, verify }) => {
    manifest.platforms['windows-x86_64'].signature = 'another-signature'
    await assert.rejects(verify(), /inline signature differs/)
    manifest.platforms['windows-x86_64'].signature = ''
    await assert.rejects(verify(), /signature missing/)
  })
})

test('rejects missing signature assets and truncated installer bytes', async () => {
  await fixture(async ({ release, root, verify }) => {
    const signature = release.assets.splice(1, 1)[0]
    await assert.rejects(verify(), /signature asset missing/)
    release.assets.push(signature)
    await writeFile(join(root, release.assets[0].name), 'bad')
    await assert.rejects(verify(), /downloaded size differs/)
  })
})

test('rejects wrong platform kinds and ambiguous asset names', async () => {
  await fixture(async ({ manifest, release, verify }) => {
    const original = manifest.platforms['darwin-aarch64']
    manifest.platforms['darwin-aarch64'] = manifest.platforms['windows-x86_64']
    await assert.rejects(verify(), /kind does not match/)
    manifest.platforms['darwin-aarch64'] = original
    release.assets.push({ ...release.assets[0], id: 900 })
    await assert.rejects(verify(), /inventory is missing or ambiguous/)
  })
})

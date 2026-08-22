import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { normalizeUpdaterManifest } from '../../packaging/updater-manifest.mjs'

const manifest = {
  version: '0.7.2',
  notes: 'fixed',
  platforms: {
    'windows-x86_64': {
      url: 'https://github.com/Moresyl/dsh-studio/releases/download/v0.7.2/app.zip',
      signature: 'trusted-signature',
    },
  },
}

test('website fallback preserves a signed updater manifest', () => {
  const normalized = normalizeUpdaterManifest(JSON.stringify(manifest), '0.7.2')
  assert.deepEqual(JSON.parse(normalized), manifest)
})

test('website fallback rejects a release/version mismatch', () => {
  assert.throws(
    () => normalizeUpdaterManifest(JSON.stringify(manifest), '0.7.3'),
    /does not match release/,
  )
})

test('website fallback rejects unsigned or insecure updater artifacts', () => {
  assert.throws(
    () =>
      normalizeUpdaterManifest(
        JSON.stringify({
          ...manifest,
          platforms: { linux: { url: 'http://example.test/app', signature: '' } },
        }),
        '0.7.2',
      ),
    /secure updater URL/,
  )
})

test('desktop and publishing workflows agree on the website fallback', async () => {
  const [configText, packageWorkflow, websiteWorkflow] = await Promise.all([
    readFile('src-tauri/tauri.conf.json', 'utf8'),
    readFile('.github/workflows/packaging.yml', 'utf8'),
    readFile('.github/workflows/website.yml', 'utf8'),
  ])
  const config = JSON.parse(configText)

  assert.deepEqual(config.plugins.updater.endpoints, [
    'https://github.com/Moresyl/dsh-studio/releases/latest/download/latest.json',
    'https://moresyl.github.io/dsh-studio/latest.json',
  ])
  assert.match(packageWorkflow, /website\/latest\.json/)
  assert.match(websiteWorkflow, /cp website\/latest\.json site\//)
})

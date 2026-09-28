import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile('.github/workflows/release.yml', 'utf8')
const builds = source.split('\n  publish:')[1]?.split('\n  checksums:')[0]
const checksums = source.split('\n  checksums:')[1]?.split('\n  updater-fallback:')[0]

test('keeps installers in a draft while platform resource and runtime checks run', () => {
  assert.ok(builds, 'release build matrix missing')
  assert.match(builds, /needs: \[quality, runtime-contract\]/)
  assert.match(builds, /releaseDraft: true/)
  assert.doesNotMatch(builds, /releaseDraft: false|--draft=false/)
  assert.match(builds, /verify-packaged-app\.mjs/)
})

test('publishes only after all build jobs, artifact inventory and uploaded checksums', () => {
  assert.ok(checksums, 'checksum gate missing')
  assert.match(checksums, /needs: publish/)
  const inventory = checksums.indexOf('node .github/scripts/verify-release-assets.mjs artifacts')
  const upload = checksums.indexOf('gh release upload "$tag" SHA256SUMS.txt')
  const publish = checksums.indexOf('gh release edit "$tag"')
  assert.ok(inventory >= 0 && upload > inventory && publish > upload)
  assert.match(checksums, /--draft=false --latest/)
  assert.equal((source.match(/--draft=false/g) ?? []).length, 1)
})

test('refuses to replace artifacts of an already public release', () => {
  assert.match(source, /--json isDraft --jq \.isDraft/)
  assert.match(
    source,
    /if \[ "\$existing_draft" = false \]; then[\s\S]*?Published release is immutable[\s\S]*?exit 1/,
  )
})

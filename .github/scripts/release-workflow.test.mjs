import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile('.github/workflows/release.yml', 'utf8')
const quality = source.split('\n  quality:')[1]?.split('\n  runtime-contract:')[0]
const preparation = source.split('\n  prepare-release:')[1]?.split('\n  publish:')[0]
const builds = source.split('\n  publish:')[1]?.split('\n  checksums:')[0]
const checksums = source.split('\n  checksums:')[1]?.split('\n  updater-fallback:')[0]
const publication = checksums?.split('- name: Publish verified release')[1]

test('keeps installers in a draft while platform resource and runtime checks run', () => {
  assert.ok(builds, 'release build matrix missing')
  assert.match(builds, /needs: \[quality, runtime-contract, prepare-release\]/)
  assert.match(builds, /releaseDraft: true/)
  assert.doesNotMatch(builds, /releaseDraft: false|--draft=false/)
  assert.match(builds, /verify-packaged-app\.mjs/)
})

test('publishes only after all build jobs, artifact inventory and uploaded checksums', () => {
  assert.ok(checksums, 'checksum gate missing')
  assert.match(checksums, /needs: publish/)
  const inventory = checksums.indexOf('node .github/scripts/verify-release-assets.mjs artifacts')
  const updater = checksums.indexOf('node .github/scripts/verify-updater-assets.mjs artifacts')
  const upload = checksums.indexOf('gh release upload "$tag" SHA256SUMS.txt')
  const publish = checksums.indexOf('gh release edit "$tag"')
  assert.ok(inventory >= 0 && updater > inventory && upload > updater && publish > upload)
  assert.match(checksums, /--draft=false --latest/)
  assert.equal((source.match(/--draft=false/g) ?? []).length, 1)
})

test('refuses to replace artifacts of an already public release', () => {
  assert.match(source, /select\(\.tag_name == \\"\$expected\\"\)/)
  assert.match(
    source,
    /if \[ "\$existing_draft" = false \]; then[\s\S]*?Published release is immutable[\s\S]*?exit 1/,
  )
})

test('binds tag pushes and manual runs to the exact remote tag commit', () => {
  assert.ok(quality, 'release quality gate missing')
  assert.match(
    quality,
    /git ls-remote origin "refs\/tags\/\$expected" "refs\/tags\/\$expected\^\{\}"/,
  )
  assert.match(quality, /if \[ -z "\$tag_object" \]; then/)
  assert.match(quality, /Manual release requires an existing tag/)
  assert.match(
    quality,
    /if \[ "\$tag_commit" != "\$GITHUB_SHA" \]; then[\s\S]*?Release commit mismatch[\s\S]*?exit 1/,
  )
  assert.doesNotMatch(quality, /git rev-parse "\$existing_target/)
  assert.ok(publication, 'verified publication step missing')
  assert.match(publication, /git ls-remote origin "refs\/tags\/\$tag" "refs\/tags\/\$tag\^\{\}"/)
  assert.match(
    publication,
    /if \[ "\$tag_commit" != "\$GITHUB_SHA" \]; then[\s\S]*?refusing to publish[\s\S]*?exit 1/,
  )
  assert.match(
    publication,
    /release_state="\$\(gh api --paginate "repos\/\$GITHUB_REPOSITORY\/releases\?per_page=100"[\s\S]*?if \[ "\$draft" != true \]; then[\s\S]*?exit 1/,
  )
  assert.doesNotMatch(publication, /releases\/tags\/\$tag/)
  assert.ok(
    publication.indexOf('Release commit changed') < publication.indexOf('gh release edit "$tag"'),
  )
})

test('rejects partial releases and clears draft assets before a full platform rebuild', () => {
  assert.ok(quality, 'release quality gate missing')
  assert.ok(preparation, 'release preparation gate missing')
  assert.match(
    quality,
    /if \[ "\$LINUX_ONLY" = true \]; then[\s\S]*?Partial release disabled[\s\S]*?exit 1/,
  )
  assert.doesNotMatch(builds, /fromJSON|linux_only/)
  for (const target of [
    'x86_64-unknown-linux-gnu',
    'x86_64-pc-windows-msvc',
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'universal-apple-darwin',
  ]) {
    assert.match(builds, new RegExp(`target: ${target}`))
  }
  assert.match(preparation, /needs: \[quality, runtime-contract\]/)
  assert.match(preparation, /git ls-remote origin "refs\/tags\/\$tag"/)
  assert.match(preparation, /if \[ "\$tag_commit" != "\$GITHUB_SHA" \]; then/)
  assert.match(preparation, /if \[ "\$draft" != true \]; then/)
  assert.match(
    preparation,
    /gh api --method DELETE "repos\/\$GITHUB_REPOSITORY\/releases\/assets\/\$asset_id"/,
  )
})

test('upgrade smoke excludes the configured release tag for every trigger type', () => {
  assert.match(builds, /if: runner\.os == 'Windows'/)
  assert.match(builds, /current="v\$\(node -p/)
  assert.match(builds, /--exclude-drafts --exclude-pre-releases --json tagName/)
  assert.match(builds, /node \.github\/scripts\/release-history\.mjs "\$current"/)
  assert.doesNotMatch(builds, /grep -Fxv "\$GITHUB_REF_NAME"/)
  assert.doesNotMatch(builds, /github\.ref_type == 'tag'/)
})

test('creates one shared draft before concurrent builds and binds uploads to its numeric ID', () => {
  assert.match(preparation, /release_id: \$\{\{ steps\.draft\.outputs\.release_id \}\}/)
  assert.match(
    preparation,
    /gh release create "\$tag"[^\n]+--verify-tag[^\n]+--notes-file release-body\.md --draft/,
  )
  assert.match(preparation, /Ambiguous draft release/)
  assert.match(preparation, /echo "release_id=\$release_id" >> "\$GITHUB_OUTPUT"/)
  assert.match(builds, /releaseId: \$\{\{ needs\.prepare-release\.outputs\.release_id \}\}/)
  assert.ok(preparation.indexOf('gh release create') < preparation.indexOf('asset_ids='))
})

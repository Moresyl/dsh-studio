import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir } from 'node:fs/promises'

import {
  catalogFiles,
  readReleaseCatalog,
  releaseSnapshot,
} from '../../packaging/release-catalog.mjs'

function release(version = '1.2.3') {
  return {
    tag_name: `v${version}`,
    name: `Studio ${version}`,
    draft: false,
    prerelease: false,
    published_at: '2026-09-29T00:00:00Z',
    author: { login: 'not-copied' },
    body: 'Notes are in the signed-updater manifest, not duplicated here',
    assets: [
      {
        id: 123,
        name: 'Studio Setup.exe',
        size: 100,
        browser_download_url: `https://github.com/Moresyl/dsh-studio/releases/download/v${version}/Studio%20Setup.exe`,
      },
    ],
  }
}

test('release snapshots preserve only bounded public release and asset fields', () => {
  const input = release()
  const snapshot = releaseSnapshot(input)
  assert.deepEqual(Object.keys(snapshot), [
    'tag_name',
    'name',
    'draft',
    'prerelease',
    'published_at',
    'assets',
  ])
  assert.deepEqual(snapshot.assets, input.assets)
  assert.equal(snapshot.body, undefined)
  assert.equal(releaseSnapshot({ ...input, name: 'x'.repeat(200) }).name.length, 160)
})

test('snapshot admission rejects draft, unpublished, ambiguous and foreign assets', () => {
  for (const patch of [
    { draft: true },
    { prerelease: true },
    { published_at: null },
    { published_at: 'yesterday' },
    { tag_name: 'v01.2.3' },
    { tag_name: 'v1.2.3/evil' },
    { assets: null },
    { assets: Array(101).fill(release().assets[0]) },
  ]) {
    assert.throws(() => releaseSnapshot({ ...release(), ...patch }))
  }
  for (const patch of [
    { id: 0 },
    { size: 0 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
    { name: '../bad' },
    { name: 'bad\\name' },
    { name: 'bad\nname' },
    { name: '' },
    { browser_download_url: 'https://example.test/Studio.exe' },
    { browser_download_url: release('1.2.4').assets[0].browser_download_url },
  ]) {
    assert.throws(() =>
      releaseSnapshot({ ...release(), assets: [{ ...release().assets[0], ...patch }] }),
    )
  }
  assert.throws(() =>
    releaseSnapshot({ ...release(), assets: [release().assets[0], release().assets[0]] }),
  )
})

test('catalog sorts semantic versions and omits unpublished or preview entries', () => {
  const files = catalogFiles([
    release('1.9.0'),
    release('1.10.0'),
    { ...release('2.0.0'), draft: true },
    release('2.0.0-rc.1'),
  ])
  assert.deepEqual(
    JSON.parse(files.get('website/versions/page-1.json')).map((item) => item.tag_name),
    ['v1.10.0', 'v1.9.0'],
  )
  assert.equal(files.has('website/versions/v2.0.0.json'), false)
  assert.throws(() => catalogFiles([release(), release()]), /Duplicate/)
  assert.throws(() => catalogFiles(Array(2001).fill(release())), /Invalid/)
})

test('catalog has an empty terminal page for zero or exact-multiple release counts', () => {
  assert.deepEqual(JSON.parse(catalogFiles([]).get('website/versions/page-1.json')), [])
  const files = catalogFiles(Array.from({ length: 20 }, (_, index) => release(`1.0.${index}`)))
  assert.equal(JSON.parse(files.get('website/versions/page-1.json')).length, 20)
  assert.deepEqual(JSON.parse(files.get('website/versions/page-2.json')), [])
})

test('catalog fetch follows full pages and stops on the first short page', async () => {
  const calls = []
  const records = await readReleaseCatalog(async (path) => {
    calls.push(path)
    return calls.length === 1
      ? Array.from({ length: 20 }, (_, index) => release(`1.0.${index}`))
      : [release()]
  })
  assert.equal(records.length, 21)
  assert.deepEqual(calls, ['releases?per_page=20&page=1', 'releases?per_page=20&page=2'])
})

test('catalog fetch rejects invalid pages and fails boundedly on a nonterminating feed', async () => {
  await assert.rejects(
    readReleaseCatalog(async () => ({})),
    /Invalid/,
  )
  await assert.rejects(
    readReleaseCatalog(async () => Array(21).fill(release())),
    /Invalid/,
  )
  let requests = 0
  await assert.rejects(
    readReleaseCatalog(async () => {
      requests += 1
      return Array(20).fill(release())
    }),
    /exceeded/,
  )
  assert.equal(requests, 101)
})

test('committed website catalog matches its version snapshots and signed fallback', async () => {
  const root = 'website/versions'
  const pages = (await readdir(root))
    .filter((name) => /^page-\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  assert(pages.length > 0)
  const seen = new Set()
  for (let index = 0; index < pages.length; index += 1) {
    assert.equal(pages[index], `page-${index + 1}.json`)
    const page = JSON.parse(await readFile(`${root}/${pages[index]}`, 'utf8'))
    assert(page.length <= 20)
    if (index < pages.length - 1) assert.equal(page.length, 20)
    else assert(page.length < 20)
    for (const record of page) {
      assert(!seen.has(record.tag_name))
      seen.add(record.tag_name)
      assert.deepEqual(releaseSnapshot(record), record)
      assert.deepEqual(
        JSON.parse(await readFile(`${root}/${record.tag_name}.json`, 'utf8')),
        record,
      )
    }
  }
  const current = JSON.parse(await readFile('website/latest.json', 'utf8'))
  assert(seen.has(`v${current.version}`))
  assert.deepEqual(
    JSON.parse(await readFile(`${root}/v${current.version}.latest.json`, 'utf8')),
    current,
  )
})

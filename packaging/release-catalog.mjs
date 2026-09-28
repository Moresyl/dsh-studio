/** Public metadata only: installer signatures remain verified by the native updater. */
const DOWNLOADS = 'https://github.com/Moresyl/dsh-studio/releases/download/'
const PAGE_SIZE = 20
const MAX_RELEASES = 2_000

function stableTag(tag) {
  return (
    typeof tag === 'string' &&
    tag.length <= 65 &&
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
  )
}

export function releaseSnapshot(release) {
  if (
    !release ||
    !stableTag(release.tag_name) ||
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.published_at !== 'string' ||
    !Number.isFinite(Date.parse(release.published_at))
  ) {
    throw new Error('Release catalog requires a published stable release')
  }
  if (!Array.isArray(release.assets) || release.assets.length > 100) {
    throw new Error('Release catalog asset inventory is invalid')
  }
  const names = new Set()
  const ids = new Set()
  const assets = release.assets.map((asset) => {
    if (
      !asset ||
      typeof asset.name !== 'string' ||
      !asset.name ||
      asset.name.length > 255 ||
      /[\\/\x00-\x1f]/.test(asset.name) ||
      asset.name.includes('..') ||
      !Number.isSafeInteger(asset.id) ||
      asset.id <= 0 ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      names.has(asset.name) ||
      ids.has(asset.id)
    ) {
      throw new Error('Release catalog asset is empty, unsafe or duplicated')
    }
    const canonical = `${DOWNLOADS}${release.tag_name}/${encodeURIComponent(asset.name)}`
    if (asset.browser_download_url !== canonical) {
      throw new Error('Release catalog asset does not belong to the published release')
    }
    names.add(asset.name)
    ids.add(asset.id)
    return { id: asset.id, name: asset.name, size: asset.size, browser_download_url: canonical }
  })
  return {
    tag_name: release.tag_name,
    name: typeof release.name === 'string' ? release.name.slice(0, 160) : null,
    draft: false,
    prerelease: false,
    published_at: release.published_at,
    assets,
  }
}

export async function readReleaseCatalog(github) {
  const releases = []
  for (let page = 1; page <= MAX_RELEASES / PAGE_SIZE + 1; page += 1) {
    const batch = await github(`releases?per_page=${PAGE_SIZE}&page=${page}`)
    if (!Array.isArray(batch) || batch.length > PAGE_SIZE)
      throw new Error('Invalid release catalog page')
    releases.push(...batch)
    if (releases.length > MAX_RELEASES) throw new Error('Release catalog exceeded its bound')
    if (batch.length < PAGE_SIZE) return releases
  }
  throw new Error('Release catalog did not terminate')
}

/** Validate every record before exposing any output to the writer. */
export function catalogFiles(releases) {
  if (!Array.isArray(releases) || releases.length > MAX_RELEASES)
    throw new Error('Invalid release catalog')
  const stable = releases
    .filter(
      (release) => release && !release.draft && !release.prerelease && stableTag(release.tag_name),
    )
    .map(releaseSnapshot)
  const tags = new Set()
  for (const release of stable) {
    if (tags.has(release.tag_name)) throw new Error('Duplicate release catalog version')
    tags.add(release.tag_name)
  }
  stable.sort((a, b) => {
    const left = a.tag_name.slice(1).split('.').map(BigInt)
    const right = b.tag_name.slice(1).split('.').map(BigInt)
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index] > right[index] ? -1 : 1
    }
    return 0
  })
  const files = new Map()
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`
  for (let start = 0; start <= stable.length; start += PAGE_SIZE) {
    files.set(
      `website/versions/page-${start / PAGE_SIZE + 1}.json`,
      json(stable.slice(start, start + PAGE_SIZE)),
    )
  }
  for (const release of stable)
    files.set(`website/versions/${release.tag_name}.json`, json(release))
  return files
}

import { readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_PLATFORMS = ['windows-x86_64', 'linux-x86_64', 'darwin-aarch64', 'darwin-x86_64']

/** Bind the manifest to this release's actual downloads, not just nonempty signatures. */
export async function verifyUpdaterAssets(root, release, version, repository) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || release?.tag_name !== `v${version}`) {
    throw new Error('updater release/tag version mismatch')
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('invalid release repository')
  const manifest = JSON.parse(await readFile(join(root, 'latest.json'), 'utf8'))
  if (manifest.version !== version) throw new Error('updater manifest version mismatch')
  const platforms = manifest.platforms
  if (!platforms || REQUIRED_PLATFORMS.some((platform) => !platforms[platform])) {
    throw new Error('updater manifest is missing a required platform')
  }
  const assets = release.assets
  if (!Array.isArray(assets) || new Set(assets.map((asset) => asset.name)).size !== assets.length) {
    throw new Error('release asset inventory is missing or ambiguous')
  }
  const verified = new Set()
  for (const [platform, entry] of Object.entries(platforms)) {
    if (typeof entry?.signature !== 'string' || !entry.signature.trim()) {
      throw new Error(`updater signature missing for ${platform}`)
    }
    const asset = assets.find((candidate) => {
      const api = `https://api.github.com/repos/${repository}/releases/assets/${candidate.id}`
      const download = `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(candidate.name)}`
      return entry.url === api || entry.url === download
    })
    if (!asset) throw new Error(`updater URL is not an asset of this release: ${platform}`)
    const name = asset.name
    if (typeof name !== 'string' || basename(name) !== name || /[\\/]/.test(name)) {
      throw new Error('unsafe updater asset name')
    }
    const expectedKind = platform.startsWith('windows-')
      ? /\.(?:exe|msi)$/i
      : platform.startsWith('linux-')
        ? /\.(?:AppImage|deb|rpm)$/i
        : platform.startsWith('darwin-')
          ? /\.app\.tar\.gz$/i
          : null
    if (!expectedKind?.test(name) || name.includes('-full-')) {
      throw new Error(`updater artifact kind does not match platform: ${platform}`)
    }
    if (!assets.some((candidate) => candidate.name === `${name}.sig`)) {
      throw new Error(`updater signature asset missing: ${name}`)
    }
    const signature = (await readFile(join(root, `${name}.sig`), 'utf8')).trim()
    if (signature !== entry.signature.trim()) {
      throw new Error(`updater inline signature differs from its artifact: ${platform}`)
    }
    const file = await stat(join(root, name))
    if (!file.isFile() || file.size === 0 || file.size !== asset.size) {
      throw new Error(`updater downloaded size differs from release inventory: ${name}`)
    }
    verified.add(name)
  }
  return { platforms: Object.keys(platforms).length, artifacts: verified.size }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const [root, inventory, version, repository] = process.argv.slice(2)
  if (!root || !inventory || !version || !repository) {
    throw new Error('usage: verify-updater-assets.mjs DIRECTORY RELEASE_JSON VERSION OWNER/REPO')
  }
  const result = await verifyUpdaterAssets(
    resolve(root),
    JSON.parse(await readFile(inventory, 'utf8')),
    version,
    repository,
  )
  console.log(
    `verified ${result.platforms} updater entries against ${result.artifacts} release artifacts`,
  )
}

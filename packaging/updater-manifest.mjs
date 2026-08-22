/** Validate and normalize the updater manifest copied to the website fallback. */
export function normalizeUpdaterManifest(text, expectedVersion) {
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (cause) {
    throw new Error(`latest.json is not valid JSON: ${cause.message}`, { cause })
  }

  if (manifest.version !== expectedVersion) {
    throw new Error(
      `latest.json version ${String(manifest.version)} does not match release ${expectedVersion}`,
    )
  }

  const platforms = Object.entries(manifest.platforms ?? {})
  if (platforms.length === 0) throw new Error('latest.json has no updater platforms')
  for (const [platform, artifact] of platforms) {
    if (!artifact || typeof artifact !== 'object') {
      throw new Error(`latest.json has no updater artifact for ${platform}`)
    }
    if (typeof artifact.url !== 'string' || !artifact.url.startsWith('https://')) {
      throw new Error(`latest.json has no secure updater URL for ${platform}`)
    }
    if (typeof artifact.signature !== 'string' || artifact.signature.trim() === '') {
      throw new Error(`latest.json has no updater signature for ${platform}`)
    }
  }

  return `${JSON.stringify(manifest, null, 2)}\n`
}

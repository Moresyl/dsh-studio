import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

function stableVersion(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return undefined
  const version = semver.valid(tag.slice(1))
  return version && semver.prerelease(version) === null ? version : undefined
}

export function selectPreviousRelease(tags, currentTag) {
  const current = stableVersion(currentTag)
  if (!current || `v${current}` !== currentTag) {
    throw new Error(`current release tag is not a canonical stable version: ${currentTag}`)
  }

  const published = [...new Set(tags)]
    .map((tag) => ({ tag, version: stableVersion(tag) }))
    .filter((entry) => entry.version)

  const newer = published
    .filter((entry) => semver.gt(entry.version, current))
    .sort((left, right) => semver.rcompare(left.version, right.version))[0]
  if (newer) {
    throw new Error(
      `release ${currentTag} is older than published stable release ${newer.tag}; refusing to replace the latest channel`,
    )
  }

  return (
    published
      .filter((entry) => semver.lt(entry.version, current))
      .sort((left, right) => semver.rcompare(left.version, right.version))[0]?.tag ?? ''
  )
}

async function main() {
  const currentTag = process.argv[2]
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) input += chunk
  process.stdout.write(selectPreviousRelease(input.split(/\r?\n/).filter(Boolean), currentTag))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}

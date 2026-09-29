import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '../..')
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

const versionParts = (version, label) => {
  const match = VERSION.exec(version)
  if (!match) throw new Error(`${label} must be one stable semantic version`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function cargoPackageVersions(lock) {
  const packages = new Map()
  for (const section of lock.split('[[package]]').slice(1)) {
    const name = /(?:^|\r?\n)name = "([^"\r\n]+)"/.exec(section)?.[1]
    const version = /(?:^|\r?\n)version = "([^"\r\n]+)"/.exec(section)?.[1]
    if (!name || !version) continue
    const versions = packages.get(name) ?? []
    versions.push(version)
    packages.set(name, versions)
  }
  return packages
}

export function validateTauriVersions(manifest, installedVersions, cargoLock) {
  const declared = { ...manifest.dependencies, ...manifest.devDependencies }
  const pairs = [
    ['@tauri-apps/api', 'tauri'],
    ['@tauri-apps/cli', 'tauri'],
    ...Object.keys(manifest.dependencies ?? {})
      .filter((name) => name.startsWith('@tauri-apps/plugin-'))
      .sort()
      .map((name) => [name, `tauri-plugin-${name.slice('@tauri-apps/plugin-'.length)}`]),
  ]
  const cargoVersions = cargoPackageVersions(cargoLock)

  return pairs.map(([guest, native]) => {
    const installed = installedVersions[guest]
    if (!installed) throw new Error(`${guest} is declared but not installed`)
    const guestParts = versionParts(installed, `installed ${guest}`)
    const expectedRange = declared[guest]
    if (typeof expectedRange !== 'string' || !expectedRange.startsWith('~')) {
      throw new Error(`${guest} must use a patch-only ~ version range`)
    }
    const rangeParts = versionParts(expectedRange.slice(1), `declared ${guest}`)
    if (
      rangeParts.major !== guestParts.major ||
      rangeParts.minor !== guestParts.minor ||
      guestParts.patch < rangeParts.patch
    ) {
      throw new Error(`${guest} declaration ${expectedRange} does not admit installed ${installed}`)
    }

    const candidates = cargoVersions.get(native) ?? []
    if (candidates.length !== 1) {
      throw new Error(
        `${native} must resolve exactly once in Cargo.lock, found ${candidates.length}`,
      )
    }
    const nativeVersion = candidates[0]
    const nativeParts = versionParts(nativeVersion, `locked ${native}`)
    if (guestParts.major !== nativeParts.major || guestParts.minor !== nativeParts.minor) {
      throw new Error(`${guest} ${installed} does not match ${native} ${nativeVersion}`)
    }
    return { guest, installed, native, nativeVersion }
  })
}

export async function verifyTauriVersions(root = DEFAULT_ROOT) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const installedVersions = Object.fromEntries(
    await Promise.all(
      [
        '@tauri-apps/api',
        '@tauri-apps/cli',
        ...Object.keys(manifest.dependencies ?? {}).filter((name) =>
          name.startsWith('@tauri-apps/plugin-'),
        ),
      ].map(async (name) => {
        const installed = JSON.parse(
          await readFile(join(root, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'),
        )
        return [name, installed.version]
      }),
    ),
  )
  const cargoLock = await readFile(join(root, 'src-tauri/Cargo.lock'), 'utf8')
  return validateTauriVersions(manifest, installedVersions, cargoLock)
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const pairs = await verifyTauriVersions(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_ROOT)
  console.log(`verified ${pairs.length} Tauri JavaScript/native version pairs`)
}

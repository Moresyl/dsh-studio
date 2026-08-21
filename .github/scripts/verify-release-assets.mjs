import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import process from 'node:process'

const root = process.argv[2]
if (!root) throw new Error('usage: node verify-release-assets.mjs <artifact-directory>')

const files = await walk(root)
const names = files.map((file) => basename(file))
const lite = (name) => !name.includes('-full-')
for (const file of files) {
  if ((await stat(file)).size === 0) throw new Error(`release artifact is empty: ${basename(file)}`)
}

const required = [
  ['Windows NSIS installer', (name) => lite(name) && name.endsWith('-setup.exe')],
  ['Windows MSI installer', (name) => lite(name) && name.endsWith('.msi')],
  ['Windows portable executable', (name) => lite(name) && name.endsWith('_x64-portable.exe')],
  ['Linux AppImage', (name) => lite(name) && name.endsWith('.AppImage')],
  ['Linux Debian package', (name) => lite(name) && name.endsWith('.deb')],
  ['Linux RPM package', (name) => lite(name) && name.endsWith('.rpm')],
  ['macOS Apple Silicon image', (name) => lite(name) && /aarch64.*\.dmg$/i.test(name)],
  ['macOS Intel image', (name) => lite(name) && /(x64|x86_64).*\.dmg$/i.test(name)],
  ['macOS Universal image', (name) => lite(name) && /universal.*\.dmg$/i.test(name)],
  ['Tauri updater manifest', (name) => name === 'latest.json'],
  ['Windows Full NSIS installer', (name) => /full-x86_64-pc-windows-msvc\.exe$/i.test(name)],
  ['Windows Full MSI installer', (name) => /full-x86_64-pc-windows-msvc\.msi$/i.test(name)],
  ['Linux Full AppImage', (name) => /full-x86_64-unknown-linux-gnu\.AppImage$/i.test(name)],
  ['Linux Full Debian package', (name) => /full-x86_64-unknown-linux-gnu\.deb$/i.test(name)],
  ['Linux Full RPM package', (name) => /full-x86_64-unknown-linux-gnu\.rpm$/i.test(name)],
  ['macOS Full Apple Silicon image', (name) => /full-aarch64-apple-darwin\.dmg$/i.test(name)],
  ['macOS Full Intel image', (name) => /full-x86_64-apple-darwin\.dmg$/i.test(name)],
  ['Protocol 3 SDK package', (name) => /^moresyl-dsh-studio-sdk-\d+\.\d+\.\d+\.tgz$/i.test(name)],
]
for (const [label, matches] of required) {
  if (!names.some(matches)) throw new Error(`release is missing ${label}`)
}

const updater = JSON.parse(await readFile(join(root, 'latest.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+/.test(updater.version ?? '')) {
  throw new Error('latest.json has no semantic version')
}
const platforms = Object.entries(updater.platforms ?? {})
if (platforms.length < 4) throw new Error('latest.json does not cover all release platforms')
for (const [platform, entry] of platforms) {
  if (!entry?.url || !entry?.signature) {
    throw new Error(`latest.json has an unsigned or missing updater for ${platform}`)
  }
}

const signatures = names.filter((name) => extname(name) === '.sig')
if (signatures.length < 4)
  throw new Error('release does not contain the expected updater signatures')
console.log(
  `verified ${files.length} non-empty release assets and ${platforms.length} signed updaters`,
)

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? walk(path) : [path]
    }),
  )
  return nested.flat()
}

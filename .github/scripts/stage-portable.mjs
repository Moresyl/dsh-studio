import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export function portableName(productName, version) {
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('portable asset needs a semantic version')
  const product = productName.replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '')
  if (!product) throw new Error('portable asset needs a product name')
  return `${product}_${version}_x64-portable.exe`
}

export async function stagePortable(root, output) {
  const directory = resolve(root)
  const entries = await readdir(directory, { withFileTypes: true })
  const executables = entries.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'),
  )
  if (executables.length !== 1) {
    throw new Error(`expected one release executable in ${directory}, found ${executables.length}`)
  }
  const source = join(directory, executables[0].name)
  if ((await stat(source)).size === 0)
    throw new Error(`portable source is empty: ${basename(source)}`)
  const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'))
  const name = portableName(config.productName, config.version)
  await mkdir(output, { recursive: true })
  await copyFile(source, join(output, name))
  console.log(name)
  return name
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const root = process.argv[2]
  const output = process.argv[3] ?? 'portable-assets'
  if (!root) throw new Error('usage: node stage-portable.mjs <release-directory> [output]')
  await stagePortable(root, output)
}

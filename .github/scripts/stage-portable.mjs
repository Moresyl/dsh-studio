import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { verifyPackagedFrontend } from './verify-packaged-frontend.mjs'
import { tarCommand } from './prepare-offline-runtime.mjs'

export function portableName(productName, version) {
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('portable asset needs a semantic version')
  const product = productName.replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.|\.$/g, '')
  if (!product) throw new Error('portable asset needs a product name')
  return `${product}_${version}_x64-portable.zip`
}

export async function stagePortable(root, output, frontend = 'dist') {
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
  const contents = join(output, name.slice(0, -4))
  // A bare executable cannot start the loopback shell: it needs dist/ beside it.
  // Refuse an existing staging directory so stale chunks cannot enter the ZIP.
  await mkdir(contents)
  await copyFile(source, join(contents, 'dsh-studio.exe'))
  await cp(frontend, join(contents, 'dist'), { recursive: true, force: false })
  await verifyPackagedFrontend(contents, frontend)
  return name
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const root = process.argv[2]
  const output = process.argv[3] ?? 'portable-assets'
  if (!root) throw new Error('usage: node stage-portable.mjs <release-directory> [output]')
  if (process.platform !== 'win32') throw new Error('Windows portable packaging requires Windows')
  const name = await stagePortable(root, output)
  const execute = promisify(execFile)
  const archive = resolve(output, name)
  const tar = tarCommand({ os: 'windows' }, process.env)
  await execute(tar, ['-a', '-cf', archive, '-C', resolve(output, name.slice(0, -4)), '.'])
  const extracted = await mkdtemp(join(tmpdir(), 'dsh-portable-verify-'))
  try {
    await execute(tar, ['-xf', archive, '-C', extracted])
    const result = await verifyPackagedFrontend(extracted)
    await execute(join(extracted, 'dsh-studio.exe'), ['--smoke-test'], {
      windowsHide: true,
      timeout: 30000,
    })
    console.log(`verified portable ZIP with ${result.files} frontend files: ${name}`)
  } finally {
    await rm(extracted, { recursive: true, force: true })
  }
}

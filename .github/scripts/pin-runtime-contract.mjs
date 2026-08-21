import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
const MIRROR_REGISTRY = 'https://registry.npmmirror.com/'

export function pinContract(lock) {
  const root = lock.packages?.['']
  if (!root?.dependencies) throw new Error('runtime lock has no root dependencies')

  const dependencies = {}
  for (const name of Object.keys(root.dependencies).sort()) {
    const installed = lock.packages[`node_modules/${name}`]
    if (!installed?.version) throw new Error(`runtime lock has no installed ${name}`)
    dependencies[name] = installed.version
  }

  const pinned = JSON.parse(
    JSON.stringify(lock, (_key, value) =>
      typeof value === 'string' && value.startsWith(MIRROR_REGISTRY)
        ? `${OFFICIAL_REGISTRY}${value.slice(MIRROR_REGISTRY.length)}`
        : value,
    ),
  )
  pinned.name = 'dsh-studio-managed-runtime'
  pinned.packages[''].name = pinned.name
  pinned.packages[''].dependencies = dependencies
  return {
    lock: pinned,
    package: {
      name: pinned.name,
      private: true,
      dependencies,
    },
  }
}

export async function pinArchive(archive, output) {
  const { stdout } = await execute('tar', ['-xOf', resolve(archive), './package-lock.json'], {
    maxBuffer: 4 * 1024 * 1024,
  })
  const contract = pinContract(JSON.parse(stdout))
  await mkdir(output, { recursive: true })
  await Promise.all([
    writeFile(join(output, 'package.json'), `${JSON.stringify(contract.package, null, 2)}\n`),
    writeFile(join(output, 'package-lock.json'), `${JSON.stringify(contract.lock, null, 2)}\n`),
  ])
  console.log(`pinned ${Object.keys(contract.lock.packages).length - 1} runtime packages`)
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const archive = process.argv[2]
  const output = process.argv[3] ?? 'src-tauri/runtime-contract'
  if (!archive) throw new Error('usage: node pin-runtime-contract.mjs <harness.tar.gz> [output]')
  await pinArchive(archive, output)
}

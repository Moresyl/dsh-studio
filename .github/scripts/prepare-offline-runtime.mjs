import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { rcompare, satisfies } from 'semver'

export const NODE_VERSION = '22.19.0'
export const HARNESS_PACKAGE = '@deepseek-ai/dsh'
export const HARNESS_VERSION = '0.1.0-rc.8'
export const PNPM_VERSION = '11.7.0'

const TARGETS = {
  'x86_64-pc-windows-msvc': {
    os: 'windows',
    arch: 'x86_64',
    nodeArchive: `node-v${NODE_VERSION}-win-x64.zip`,
  },
  'x86_64-unknown-linux-gnu': {
    os: 'linux',
    arch: 'x86_64',
    nodeArchive: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
  },
  'aarch64-apple-darwin': {
    os: 'macos',
    arch: 'aarch64',
    nodeArchive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
  },
  'x86_64-apple-darwin': {
    os: 'macos',
    arch: 'x86_64',
    nodeArchive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
  },
}

export function targetPlan(target) {
  const plan = TARGETS[target]
  if (!plan) throw new Error(`offline runtime does not support target ${target}`)
  return { ...plan }
}

export async function prepare(target, output) {
  const plan = targetPlan(target)
  const destination = resolve(output)
  if (basename(destination) !== 'offline' || basename(dirname(destination)) !== 'runtime-cache') {
    throw new Error('offline runtime output must be a runtime-cache/offline directory')
  }

  const scratch = await mkdtemp(join(tmpdir(), 'dsh-studio-offline-build-'))
  try {
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })

    const release = `https://nodejs.org/dist/v${NODE_VERSION}`
    const checksums = await downloadText(`${release}/SHASUMS256.txt`)
    const expectedNodeHash = checksumFor(checksums, plan.nodeArchive)
    const nodeTemporary = join(scratch, plan.nodeArchive)
    await download(`${release}/${plan.nodeArchive}`, nodeTemporary)
    const actualNodeHash = await sha256(nodeTemporary)
    if (actualNodeHash !== expectedNodeHash) {
      throw new Error(`${plan.nodeArchive} does not match Node.js SHASUMS256.txt`)
    }
    const nodeDestination = join(destination, plan.nodeArchive)
    // Runner temp and the checkout can be on different Windows volumes, where
    // rename is not an atomic move but an EXDEV failure.
    await copyFile(nodeTemporary, nodeDestination)

    // Build the dependency closure with the exact Node/npm pair the package
    // will carry. This avoids the host runner's moving npm version changing the
    // peer solver or lockfile shape.
    const npm = await unpackedNpm(nodeDestination, scratch, plan)
    await run(npm.node, ['--version'])

    const harnessRoot = join(scratch, 'harness')
    await mkdir(harnessRoot)
    await run(npm.node, [
      npm.cli,
      'install',
      '--prefix',
      harnessRoot,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts=false',
      // The published DSH family pins one coherent peer graph. Asking npm to
      // re-solve that graph can consume gigabytes for minutes on a cold cache;
      // the runtime closure is independently executed below instead.
      '--legacy-peer-deps',
      `${HARNESS_PACKAGE}@${HARNESS_VERSION}`,
      `pnpm@${PNPM_VERSION}`,
    ])
    await installPeerClosure(npm, harnessRoot)
    const packageRoot = join(harnessRoot, 'node_modules', '@deepseek-ai', 'dsh')
    const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    if (installed.name !== HARNESS_PACKAGE || installed.version !== HARNESS_VERSION) {
      throw new Error(
        `offline install resolved ${installed.name ?? 'unknown'}@${installed.version ?? 'unknown'}`,
      )
    }
    const harnessEntry = join(packageRoot, 'lib', 'bin.js')
    await access(harnessEntry)
    const pnpmEntry = join(harnessRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    await access(pnpmEntry)
    await run(npm.node, [harnessEntry, '--help'])
    await run(npm.node, [pnpmEntry, '--version'])

    const harnessFile = 'harness.tar.gz'
    const harnessArchive = join(destination, harnessFile)
    await run('tar', ['-czf', harnessArchive, '-C', harnessRoot, '.'])
    const harnessHash = await sha256(harnessArchive)
    const manifest = {
      schema: 1,
      os: plan.os,
      arch: plan.arch,
      node: {
        file: plan.nodeArchive,
        sha256: actualNodeHash,
        version: `v${NODE_VERSION}`,
      },
      harness: {
        file: harnessFile,
        sha256: harnessHash,
        package: HARNESS_PACKAGE,
        version: HARNESS_VERSION,
      },
    }
    await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(
      `prepared verified offline runtime for ${target}: Node ${NODE_VERSION}, ${HARNESS_PACKAGE}@${HARNESS_VERSION}`,
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function unpackedNpm(nodeArchive, scratch, plan) {
  const root = join(scratch, 'node-toolchain')
  await mkdir(root)
  await run('tar', ['-xf', nodeArchive, '-C', root])
  const entries = await readdir(root, { withFileTypes: true })
  const releases = entries.filter((entry) => entry.isDirectory())
  if (releases.length !== 1) throw new Error('Node archive does not contain one release directory')
  const release = join(root, releases[0].name)
  return plan.os === 'windows'
    ? {
        node: join(release, 'node.exe'),
        cli: join(release, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      }
    : {
        node: join(release, 'bin', 'node'),
        cli: join(release, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      }
}

async function installPeerClosure(npm, root) {
  for (let pass = 1; pass <= 12; pass += 1) {
    const manifests = await installedManifests(join(root, 'node_modules'))
    const installed = await installedPackageNames(join(root, 'node_modules'))
    const missing = new Map()
    for (const manifest of manifests) {
      for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
        if (manifest.peerDependenciesMeta?.[name]?.optional || installed.has(name)) continue
        const ranges = missing.get(name) ?? new Set()
        ranges.add(range)
        missing.set(name, ranges)
      }
    }
    if (missing.size === 0) {
      console.log(`verified a closed peer graph across ${manifests.length} installed packages`)
      return
    }

    const specs = await Promise.all(
      [...missing]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(async ([name, ranges]) => `${name}@${await peerVersion(name, [...ranges])}`),
    )
    console.log(`peer closure pass ${pass}: installing ${specs.length} required package(s)`)
    await run(npm.node, [
      npm.cli,
      'install',
      '--prefix',
      root,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts=false',
      '--legacy-peer-deps',
      ...specs,
    ])
  }
  throw new Error('offline runtime peer closure did not converge')
}

async function peerVersion(name, ranges) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { Accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for peer ${name}`)
  const packument = await response.json()
  const versions = Object.keys(packument.versions ?? {})
  const candidates = versions.filter((version) =>
    ranges.every((range) => satisfies(version, range)),
  )

  // Keep every first-party package on the exact family this application tested,
  // even when a caret would admit a newer prerelease published later.
  const preferred =
    name.startsWith('@deepseek-ai/dsh-') && candidates.includes(HARNESS_VERSION)
      ? HARNESS_VERSION
      : candidates.sort(rcompare)[0]
  if (!preferred) {
    throw new Error(`${name} has no version satisfying required peers: ${ranges.join(', ')}`)
  }
  return preferred
}

async function installedManifests(nodeModules) {
  let entries
  try {
    entries = await readdir(nodeModules, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      const scoped = await readdir(join(nodeModules, entry.name), { withFileTypes: true })
      for (const child of scoped) {
        if (child.isDirectory()) directories.push(join(nodeModules, entry.name, child.name))
      }
    } else {
      directories.push(join(nodeModules, entry.name))
    }
  }

  const manifests = []
  for (const directory of directories) {
    try {
      manifests.push(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    manifests.push(...(await installedManifests(join(directory, 'node_modules'))))
  }
  return manifests
}

async function installedPackageNames(nodeModules) {
  const entries = await readdir(nodeModules, { withFileTypes: true })
  const names = new Set()
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    if (!entry.name.startsWith('@')) {
      names.add(entry.name)
      continue
    }
    const scoped = await readdir(join(nodeModules, entry.name), { withFileTypes: true })
    for (const child of scoped) {
      if (child.isDirectory()) names.add(`${entry.name}/${child.name}`)
    }
  }
  return names
}

function checksumFor(text, archive) {
  const row = text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, file]) => file === archive)
  if (!row || !/^[a-f0-9]{64}$/i.test(row[0])) {
    throw new Error(`Node.js SHASUMS256.txt does not contain ${archive}`)
  }
  return row[0].toLowerCase()
}

async function downloadText(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.text()
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`)
  const file = await import('node:fs').then(({ createWriteStream }) =>
    createWriteStream(destination),
  )
  await new Promise((resolve, reject) => {
    Readable.fromWeb(response.body).pipe(file).on('finish', resolve).on('error', reject)
  })
}

async function sha256(file) {
  const digest = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => digest.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  })
  return digest.digest('hex')
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const target = process.argv[2]
  const output = process.argv[3] ?? 'src-tauri/runtime-cache/offline'
  if (!target) throw new Error('usage: node prepare-offline-runtime.mjs <rust-target> [output]')
  await prepare(target, output)
}

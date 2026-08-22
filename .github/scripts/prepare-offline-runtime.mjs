import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  cp,
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

export const NODE_VERSION = '22.19.0'
export const HARNESS_PACKAGE = '@deepseek-ai/dsh'
export const HARNESS_VERSION = '0.1.1-rc.2'
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
    await copyRuntimeContract(harnessRoot)
    await run(npm.node, [npm.cli, ...offlineNpmCiArgs(harnessRoot)])
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
    const actualPnpm = (await capture(npm.node, [pnpmEntry, '--version'], harnessRoot)).trim()
    requireExactVersion(actualPnpm, PNPM_VERSION, 'offline pnpm')

    const harnessFile = 'harness.tar.gz'
    const harnessArchive = join(destination, harnessFile)
    const archive = tarCreatePlan(harnessArchive, harnessRoot)
    await run('tar', archive.args, archive.cwd)
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
      pnpm: {
        version: PNPM_VERSION,
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
  const archive = tarExtractPlan(nodeArchive, root)
  await run(tarCommand(plan, process.env), archive.args, archive.cwd)
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

export function tarCreatePlan(archive, source) {
  return {
    // Windows tar treats the colon in an absolute archive path (for example,
    // D:\\...) as a remote-host separator. Keep the archive argument local.
    cwd: dirname(archive),
    args: ['-czf', basename(archive), '-C', source, '.'],
  }
}

export function tarExtractPlan(archive, destination) {
  return {
    cwd: dirname(archive),
    args: ['-xf', basename(archive), '-C', destination],
  }
}

export function tarCommand(plan, environment) {
  if (plan.os !== 'windows') return 'tar'
  const systemRoot = environment.SystemRoot || environment.WINDIR
  if (!systemRoot) throw new Error('Windows offline packaging requires SystemRoot or WINDIR')
  // Git Bash puts GNU tar first on PATH, but GNU tar cannot extract Node's ZIP.
  // Windows ships bsdtar at this stable path and it supports both ZIP and tar.
  return join(systemRoot, 'System32', 'tar.exe')
}

export async function copyRuntimeContract(destination) {
  const source = 'src-tauri/runtime-contract'
  await Promise.all([
    copyFile(join(source, 'package.json'), join(destination, 'package.json')),
    copyFile(join(source, 'package-lock.json'), join(destination, 'package-lock.json')),
    cp(join(source, 'dsh-studio-integration'), join(destination, 'dsh-studio-integration'), {
      recursive: true,
    }),
  ])
}

export function offlineNpmCiArgs(prefix) {
  return [
    'ci',
    '--prefix',
    prefix,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts=false',
    // The committed lock records the qualified peer graph. npm must use the
    // same peer mode that produced it instead of trying to solve it again.
    '--legacy-peer-deps',
    // The contract's bundled Studio integration is a local file dependency.
    // Materialize it exactly as online install and cold verification do; npm's
    // default link representation is not compatible with this qualified lock.
    '--install-links',
  ]
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.trim()}`))
    })
  })
}

export function requireExactVersion(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} resolved ${actual || 'no version'}, expected ${expected}`)
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const target = process.argv[2]
  const output = process.argv[3] ?? 'src-tauri/runtime-cache/offline'
  if (!target) throw new Error('usage: node prepare-offline-runtime.mjs <rust-target> [output]')
  await prepare(target, output)
}

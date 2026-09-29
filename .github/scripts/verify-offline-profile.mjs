import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  HARNESS_VERSION,
  HARNESS_PACKAGE,
  NODE_VERSION,
  PNPM_VERSION,
  tarCommand,
  tarExtractPlan,
} from './prepare-offline-runtime.mjs'
import { verifyProfileBoot } from './runtime-profile-smoke.mjs'

const execute = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))

export function validateOfflineManifest(
  manifest,
  platform = process.platform,
  arch = process.arch,
) {
  const os = { win32: 'windows', linux: 'linux', darwin: 'macos' }[platform]
  const architecture = { x64: 'x86_64', arm64: 'aarch64' }[arch]
  if (
    !os ||
    !architecture ||
    manifest?.schema !== 1 ||
    manifest.os !== os ||
    manifest.arch !== architecture
  ) {
    throw new Error('packaged offline platform does not match this runner')
  }
  if (
    manifest.node?.version !== `v${NODE_VERSION}` ||
    manifest.harness?.package !== HARNESS_PACKAGE ||
    manifest.harness?.version !== HARNESS_VERSION ||
    manifest.pnpm?.version !== PNPM_VERSION
  ) {
    throw new Error('packaged offline versions do not match the pinned runtime')
  }
  for (const artifact of [manifest.node, manifest.harness]) {
    if (
      typeof artifact.file !== 'string' ||
      !artifact.file ||
      /[\\/:\0]/.test(artifact.file) ||
      artifact.file === '..' ||
      artifact.file === '.'
    ) {
      throw new Error('invalid packaged offline archive name')
    }
  }
}

export function nativeRuntimeTestArgs(os, arch, release = false) {
  const target = {
    'windows-x86_64': 'x86_64-pc-windows-msvc',
    'linux-x86_64': 'x86_64-unknown-linux-gnu',
    'macos-aarch64': 'aarch64-apple-darwin',
    'macos-x86_64': 'x86_64-apple-darwin',
  }[`${os}-${arch}`]
  if (!target) throw new Error('unsupported native Full acceptance target')
  return [
    'test',
    '--manifest-path',
    join(HERE, '../../src-tauri/Cargo.toml'),
    ...(release ? ['--release', '--target', target] : []),
    '--lib',
    'packaged_full_runtime_restores_native_contract',
    '--',
    '--ignored',
    '--nocapture',
  ]
}

/** Boot the already hash-verified packaged closure with its own Node executable. */
export async function verifyOfflineProfile(offline) {
  const manifest = JSON.parse(await readFile(join(offline, 'manifest.json'), 'utf8'))
  validateOfflineManifest(manifest)
  const version = JSON.parse(await readFile(join(HERE, '../../package.json'), 'utf8')).version
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-packaged-profile-'))
  try {
    for (const [kind, artifact] of Object.entries({
      node: manifest.node,
    })) {
      if (!artifact || basename(artifact.file) !== artifact.file || /[\\/]/.test(artifact.file)) {
        throw new Error(`invalid packaged ${kind} archive name`)
      }
      const target = join(scratch, kind)
      await mkdir(target)
      const plan = tarExtractPlan(join(resolve(offline), artifact.file), target)
      await execute(tarCommand({ os: manifest.os }, process.env), plan.args, {
        cwd: plan.cwd,
        windowsHide: true,
        timeout: 180000,
      })
    }
    const nodeDirectory = manifest.node.file.replace(/(?:\.tar\.gz|\.zip)$/, '')
    const binary = join(
      scratch,
      'node',
      nodeDirectory,
      ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']),
    )
    console.log('verifying native Full install, rejected-archive/startup recovery and reinstall')
    await execute(
      'cargo',
      nativeRuntimeTestArgs(manifest.os, manifest.arch, process.env.GITHUB_ACTIONS === 'true'),
      {
        cwd: join(HERE, '../..'),
        env: {
          ...process.env,
          DSH_TEST_OFFLINE_DIR: resolve(offline),
          DSH_STUDIO_DATA_DIR: join(scratch, 'native'),
          DSH_TEST_NODE: binary,
        },
        windowsHide: true,
        // The release-profile native test may need its first optimized link
        // on an ephemeral runner before restoring the large archive twice.
        timeout: 900000,
        maxBuffer: 2 << 20,
      },
    )
    const { stdout } = await execute(
      binary,
      [
        fileURLToPath(import.meta.url),
        '--boot',
        join(scratch, 'native', 'harness'),
        scratch,
        version,
      ],
      { windowsHide: true, timeout: 180000, maxBuffer: 2 << 20 },
    )
    const result = JSON.parse(stdout)
    if (result.node !== `v${NODE_VERSION}` || result.harness !== HARNESS_VERSION || !result.ready) {
      throw new Error('packaged offline profile did not satisfy the runtime contract')
    }
    return result
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  const [mode, runtimeRoot, scratch, studioVersion] = process.argv.slice(2)
  if (mode !== '--boot' || !runtimeRoot || !scratch || !/^\d+\.\d+\.\d+$/.test(studioVersion)) {
    throw new Error('internal usage: verify-offline-profile.mjs --boot RUNTIME SCRATCH VERSION')
  }
  if (process.version !== `v${NODE_VERSION}`) throw new Error('packaged Node version mismatch')
  const launcher = join(runtimeRoot, 'studio-cli.mjs')
  // Exercise the native installer's launcher, never synthesize a replacement
  // here: doing so would hide missing launchers in an otherwise valid archive.
  await access(launcher)
  await verifyProfileBoot({
    entry: launcher,
    runtimeRoot,
    dshHome: join(scratch, 'home'),
    studioVersion,
    harnessVersion: HARNESS_VERSION,
  })
  // Never include the one-time authentication token in packaging logs.
  console.log(JSON.stringify({ node: process.version, harness: HARNESS_VERSION, ready: true }))
}

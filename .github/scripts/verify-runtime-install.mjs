import { copyFile, cp, lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { verifyProfileBoot } from './runtime-profile-smoke.mjs'

const expected = '0.1.1-rc.2'
const expectedPnpm = '11.7.0'
const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-contract-'))

try {
  const npm =
    process.platform === 'win32'
      ? {
          command: process.execPath,
          args: [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')],
        }
      : { command: 'npm', args: [] }
  await Promise.all([
    copyFile('src-tauri/runtime-contract/package.json', join(directory, 'package.json')),
    copyFile('src-tauri/runtime-contract/package-lock.json', join(directory, 'package-lock.json')),
    cp(
      'src-tauri/runtime-contract/dsh-studio-integration',
      join(directory, 'dsh-studio-integration'),
      { recursive: true },
    ),
  ])
  await run(npm.command, [
    ...npm.args,
    'ci',
    '--prefix',
    directory,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts=false',
    '--legacy-peer-deps',
    '--install-links',
    '--foreground-scripts',
    '--loglevel=http',
    '--registry=https://registry.npmjs.org/',
    '--fetch-retries=2',
    '--fetch-timeout=60000',
  ])
  const packageRoot = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.version !== expected) {
    throw new Error(`installed ${manifest.version ?? 'unknown'}, expected ${expected}`)
  }
  const entry = join(packageRoot, 'lib', 'bin.js')
  await stat(entry)
  const pnpm = JSON.parse(
    await readFile(join(directory, 'node_modules', 'pnpm', 'package.json'), 'utf8'),
  )
  if (pnpm.version !== expectedPnpm) {
    throw new Error(`installed pnpm ${pnpm.version ?? 'unknown'}, expected ${expectedPnpm}`)
  }
  const integrationRoot = join(directory, 'node_modules', '@moresyl', 'dsh-studio-integration')
  const integrationMetadata = await lstat(integrationRoot)
  if (integrationMetadata.isSymbolicLink()) {
    throw new Error('Studio integration was linked instead of materialized')
  }
  await stat(join(integrationRoot, 'lib', 'client.js'))
  const picker = await readFile(
    join(
      directory,
      'node_modules',
      '@deepseek-ai',
      'dsh-client-ui-directory-picker-browse',
      'lib',
      'client.js',
    ),
    'utf8',
  )
  for (const seam of [
    'function DirectoryBrowser({ open, listDirectory, createDirectory, onOpen, onClose, busy, t }) {',
    'const parentInert = busy || folderDraft !== null;',
    'if (targetPath !== null) onOpen(targetPath);',
    'createDirectory: (path, name) => ctx.workspaces.createDirectory(path, name),',
  ]) {
    if (picker.split(seam).length !== 2) {
      throw new Error(`qualified directory picker seam changed: ${seam}`)
    }
  }
  await run(process.execPath, [entry, '--help'], { timeout: 120_000 })
  const dshHome = join(directory, 'dsh-home')
  const origin = await verifyProfileBoot({
    entry,
    runtimeRoot: directory,
    dshHome,
    studioVersion: '0.8.0',
    harnessVersion: expected,
  })
  console.log(
    `cold-installed and fully booted the pinned ${manifest.name}@${expected} runtime graph at ${origin}`,
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}

function run(command, args, { timeout = 1_500_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} exceeded ${Math.round(timeout / 1000)} seconds`))
    }, timeout)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

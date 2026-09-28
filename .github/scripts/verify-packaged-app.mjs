import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verifyPackagedFrontend } from './verify-packaged-frontend.mjs'
import { verifyOfflineProfile } from './verify-offline-profile.mjs'

let scratch
const bootedPayloads = new Set()
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  const root = resolveBundleRoot(process.argv[2])
  scratch = await mkdtemp(join(tmpdir(), 'dsh-studio-package-smoke-'))
  try {
    const files = await walk(root)
    if (process.platform === 'win32') await verifyWindows(files)
    else if (process.platform === 'darwin') await verifyMac(files)
    else await verifyLinux(files)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export function resolveBundleRoot(root) {
  if (!root) throw new Error('usage: node verify-packaged-app.mjs <tauri-bundle-directory>')
  return resolve(root)
}

export function shouldExerciseWindowsInstaller(environment = process.env) {
  return (
    environment.GITHUB_ACTIONS === 'true' || environment.DSH_ALLOW_LOCAL_INSTALLER_SMOKE === '1'
  )
}

async function verifyWindows(files) {
  const msi = requireOne(files, (file) => file.toLowerCase().endsWith('.msi'), 'MSI')
  const nsis = requireOne(
    files,
    (file) => file.toLowerCase().endsWith('.exe') && !file.toLowerCase().endsWith('.sig'),
    'NSIS installer',
  )

  const msiRoot = join(scratch, 'msi')
  await run('msiexec.exe', ['/a', msi, '/qn', `TARGETDIR=${msiRoot}`])
  await verifyResources(msiRoot)
  await smoke(await installedExecutable(msiRoot))

  // NSIS writes per-user installation and uninstall registration even when /D
  // points at a temporary directory. That is acceptable on an ephemeral CI
  // runner, but a local release rehearsal must never take over the developer's
  // real updater registration or leave a temp build as the primary app.
  if (!shouldExerciseWindowsInstaller()) {
    console.log(
      'verified MSI extraction and packaged binary; skipped stateful NSIS install outside GitHub Actions',
    )
    return
  }

  const nsisRoot = join(scratch, 'nsis')
  // NSIS requires /D to be the final argument. spawn() passes it as one value,
  // so spaces in the temporary path are never interpreted by a shell.
  await run(nsis, ['/S', `/D=${nsisRoot}`], { env: isolatedEnvironment('nsis') })
  await verifyResources(nsisRoot)
  await smoke(await installedExecutable(nsisRoot))
  const uninstaller = (await walk(nsisRoot)).find(
    (file) => basename(file).toLowerCase() === 'uninstall.exe',
  )
  if (!uninstaller) throw new Error('NSIS installation contains no uninstaller')
  await run(uninstaller, windowsUninstallerArgs(nsisRoot))
  await finalizeWindowsUninstall(nsisRoot, uninstaller)
  if (process.env.DSH_PREVIOUS_INSTALLER) {
    await verifyWindowsUpgrade(process.env.DSH_PREVIOUS_INSTALLER, nsis)
  }
  if (process.env.DSH_EXPECT_OFFLINE === '1' && process.env.DSH_PREVIOUS_FULL_INSTALLER) {
    await verifyWindowsUpgrade(process.env.DSH_PREVIOUS_FULL_INSTALLER, nsis)
  }
  console.log('verified MSI extraction and NSIS installation by executing both packaged binaries')
}

async function verifyWindowsUpgrade(previous, current) {
  const root = join(scratch, 'upgrade')
  const environment = isolatedEnvironment('upgrade')
  await run(previous, ['/S', `/D=${root}`], { env: environment })
  const previousHash = await sha256(await installedExecutable(root))
  const snapshot = await mkdtemp(join(scratch, 'previous-frontend-'))
  await cp(join(root, 'dist'), snapshot, { recursive: true })
  const markers = await Promise.all(
    Object.values(environment).map(async (directory) => {
      const path = join(directory, 'application-transition-preserve.txt')
      await writeFile(path, 'Preserve existing user data across application versions.\n')
      return { path, hash: await sha256(path) }
    }),
  )
  await run(current, ['/S', `/D=${root}`], { env: environment })
  await verifyResources(root)
  await smoke(await installedExecutable(root))
  const currentHash = await sha256(await installedExecutable(root))
  // Exercise the same NSIS /UPDATE route used by Tauri's updater. Its automatic
  // relaunch receives --smoke-test so an ephemeral runner never leaves a GUI
  // process using the installation while the next transition begins.
  await run(previous, windowsUpdateArgs(), { env: environment })
  if ((await sha256(await installedExecutable(root))) !== previousHash) {
    throw new Error('Windows application downgrade did not restore the previous binary')
  }
  await verifyPackagedFrontend(root, snapshot)
  await smoke(await installedExecutable(root))
  await run(current, windowsUpdateArgs(), { env: environment })
  if ((await sha256(await installedExecutable(root))) !== currentHash) {
    throw new Error('Windows application re-upgrade did not restore the current binary')
  }
  await verifyResources(root)
  await smoke(await installedExecutable(root))
  for (const marker of markers) {
    if ((await sha256(marker.path)) !== marker.hash)
      throw new Error('Application version switching modified existing data')
  }
  const uninstaller = (await walk(root)).find(
    (file) => basename(file).toLowerCase() === 'uninstall.exe',
  )
  if (!uninstaller) throw new Error('upgraded NSIS installation contains no uninstaller')
  await run(uninstaller, windowsUninstallerArgs(root))
  await finalizeWindowsUninstall(root, uninstaller)
  console.log(
    `verified ${basename(previous)} upgrade, updater downgrade, re-upgrade, resource bytes and data preservation`,
  )
}

export function windowsUpdateArgs() {
  return ['/S', '/UPDATE', '/ARGS', '--smoke-test']
}

export function windowsUninstallerArgs(root) {
  if (!root) throw new Error('Windows uninstall root is required')
  return ['/S', `_?=${resolve(root)}`]
}

export async function finalizeWindowsUninstall(root, uninstaller) {
  // _?= keeps NSIS in the original uninstaller process so run() can wait for
  // the real uninstall. The caller must then remove that executable itself.
  await rm(uninstaller, { force: true })
  let remaining
  try {
    remaining = await walk(root)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  if (remaining.length > 0) {
    const names = remaining
      .slice(0, 10)
      .map((file) => relative(root, file))
      .join(', ')
    throw new Error(`silent uninstall left packaged files under ${root}: ${names}`)
  }
  await rm(root, { recursive: true, force: true })
}

async function verifyMac(files) {
  const dmg = requireOne(files, (file) => file.toLowerCase().endsWith('.dmg'), 'DMG')
  const output = await capture('hdiutil', ['attach', '-readonly', '-nobrowse', dmg])
  const mount = output
    .split(/\r?\n/)
    .map((line) => line.match(/(\/Volumes\/.*)$/)?.[1])
    .find(Boolean)
  if (!mount) throw new Error('hdiutil did not report a mounted volume')
  try {
    const executable = (await walk(mount)).find(
      (file) => file.includes('.app/Contents/MacOS/') && basename(file) === 'dsh-studio',
    )
    if (!executable) throw new Error('DMG contains no DSH Studio application executable')
    await verifyResources(mount)
    await smoke(executable)
  } finally {
    await run('hdiutil', ['detach', mount])
  }
  console.log('mounted the DMG and executed its packaged application binary')
}

async function verifyLinux(files) {
  const appImage = requireOne(files, (file) => file.toLowerCase().endsWith('.appimage'), 'AppImage')
  const deb = requireOne(files, (file) => file.toLowerCase().endsWith('.deb'), 'Debian package')
  const rpm = requireOne(files, (file) => file.toLowerCase().endsWith('.rpm'), 'RPM package')

  await chmod(appImage, 0o755)
  const appImageRoot = join(scratch, 'appimage')
  await run(appImage, ['--appimage-extract'], { cwd: appImageRoot, createCwd: true })
  await verifyResources(appImageRoot)
  await smoke(await installedExecutable(appImageRoot))

  const debRoot = join(scratch, 'deb')
  await run('dpkg-deb', ['--extract', deb, debRoot])
  await verifyResources(debRoot)
  await smoke(await installedExecutable(debRoot))

  const rpmRoot = join(scratch, 'rpm')
  await extractRpm(rpm, rpmRoot)
  await verifyResources(rpmRoot)
  await smoke(await installedExecutable(rpmRoot))
  console.log('extracted AppImage, DEB and RPM and executed every packaged application binary')
}

async function extractRpm(rpm, directory) {
  await mkdir(directory, { recursive: true })
  await run('bsdtar', rpmExtractArgs(rpm, directory))
}

export function rpmExtractArgs(rpm, directory) {
  if (!rpm || !directory) throw new Error('RPM archive and extraction directory are required')
  return ['-xf', rpm, '-C', directory]
}

async function installedExecutable(directory) {
  const files = await walk(directory)
  const executable = files.find((file) => {
    const name = basename(file).toLowerCase()
    return (
      (name === 'dsh-studio' || name === 'dsh-studio.exe' || name === 'dsh studio.exe') &&
      !file.toLowerCase().includes('uninstall')
    )
  })
  if (!executable) throw new Error(`no packaged DSH Studio executable found under ${directory}`)
  return executable
}

async function smoke(executable) {
  await run(executable, ['--smoke-test'], {
    timeout: 30_000,
    env: isolatedEnvironment(`smoke-${basename(dirname(executable))}`),
  })
}

function isolatedEnvironment(name) {
  const root = join(scratch, 'isolated', name)
  return {
    DSH_HOME: join(root, 'dsh-home'),
    LOCALAPPDATA: join(root, 'local-app-data'),
    APPDATA: join(root, 'roaming-app-data'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
  }
}

async function verifyResources(directory) {
  const frontend = await verifyPackagedFrontend(directory)
  console.log(`verified ${frontend.files} packaged frontend files against the current build`)
  if (process.env.DSH_EXPECT_OFFLINE !== '1') return
  // The native loader resolves offline/ beside dist/, not an arbitrary nested
  // directory with the same suffix. A misplaced archive is unusable offline.
  const manifestPath = join(dirname(frontend.root), 'offline', 'manifest.json')
  await access(manifestPath).catch(() => {
    throw new Error('Full package has no offline/manifest.json beside its frontend resources')
  })
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const expectedOs = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]
  if (manifest.schema !== 1 || manifest.os !== expectedOs) {
    throw new Error(`Full package has an invalid offline manifest for ${process.platform}`)
  }
  if (manifest.pnpm?.version !== '11.7.0') {
    throw new Error('Full package does not carry the pinned pnpm 11.7.0 runtime')
  }
  const root = dirname(manifestPath)
  for (const [name, artifact] of Object.entries({
    node: manifest.node,
    harness: manifest.harness,
  })) {
    if (
      !artifact ||
      basename(artifact.file) !== artifact.file ||
      !/^[a-f0-9]{64}$/i.test(artifact.sha256)
    ) {
      throw new Error(`Full package has invalid ${name} artifact metadata`)
    }
    const file = join(root, artifact.file)
    await access(file)
    const actual = await sha256(file)
    if (actual !== artifact.sha256.toLowerCase()) {
      throw new Error(`Full package ${name} artifact failed its SHA-256 check`)
    }
  }
  const identity = `${manifest.node.sha256}:${manifest.harness.sha256}`
  if (!bootedPayloads.has(identity)) {
    const boot = await verifyOfflineProfile(root)
    bootedPayloads.add(identity)
    console.log(
      `booted the packaged offline Profile with Node ${boot.node} / Harness ${boot.harness}`,
    )
  }
}

async function sha256(file) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  })
  return hash.digest('hex')
}

function requireOne(files, predicate, label) {
  const found = files.find(predicate)
  if (!found) throw new Error(`Tauri bundle contains no ${label}`)
  return found
}

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

async function run(command, args, { timeout = 120_000, cwd, createCwd = false, env } = {}) {
  if (createCwd) await mkdir(cwd, { recursive: true })
  if (env)
    await Promise.all(Object.values(env).map((directory) => mkdir(directory, { recursive: true })))
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: 'inherit',
    })
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

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`${command} exited with ${code}`))
    })
  })
}

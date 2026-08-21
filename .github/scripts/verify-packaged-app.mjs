import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let scratch
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

async function verifyWindows(files) {
  const msi = requireOne(files, (file) => file.toLowerCase().endsWith('.msi'), 'MSI')
  const nsis = requireOne(
    files,
    (file) => file.toLowerCase().endsWith('.exe') && !file.toLowerCase().endsWith('.sig'),
    'NSIS installer',
  )

  const msiRoot = join(scratch, 'msi')
  await run('msiexec.exe', ['/a', msi, '/qn', `TARGETDIR=${msiRoot}`])
  await verifyOffline(msiRoot)
  await smoke(await installedExecutable(msiRoot))

  const nsisRoot = join(scratch, 'nsis')
  // NSIS requires /D to be the final argument. spawn() passes it as one value,
  // so spaces in the temporary path are never interpreted by a shell.
  await run(nsis, ['/S', `/D=${nsisRoot}`])
  await verifyOffline(nsisRoot)
  await smoke(await installedExecutable(nsisRoot))
  const uninstaller = (await walk(nsisRoot)).find(
    (file) => basename(file).toLowerCase() === 'uninstall.exe',
  )
  if (!uninstaller) throw new Error('NSIS installation contains no uninstaller')
  await run(uninstaller, ['/S'])
  await waitUntilRemoved(nsisRoot)
  if (process.env.DSH_PREVIOUS_INSTALLER) {
    await verifyWindowsUpgrade(process.env.DSH_PREVIOUS_INSTALLER, nsis)
  }
  console.log('verified MSI extraction and NSIS installation by executing both packaged binaries')
}

async function verifyWindowsUpgrade(previous, current) {
  const root = join(scratch, 'upgrade')
  await run(previous, ['/S', `/D=${root}`])
  await installedExecutable(root)
  await run(current, ['/S', `/D=${root}`])
  await smoke(await installedExecutable(root))
  const uninstaller = (await walk(root)).find(
    (file) => basename(file).toLowerCase() === 'uninstall.exe',
  )
  if (!uninstaller) throw new Error('upgraded NSIS installation contains no uninstaller')
  await run(uninstaller, ['/S'])
  await waitUntilRemoved(root)
  console.log(`upgraded ${basename(previous)} in place and executed the new application binary`)
}

async function waitUntilRemoved(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await access(path)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`silent uninstall did not remove ${path}`)
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
    await verifyOffline(mount)
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
  await verifyOffline(appImageRoot)
  await smoke(await installedExecutable(appImageRoot))

  const debRoot = join(scratch, 'deb')
  await run('dpkg-deb', ['--extract', deb, debRoot])
  await verifyOffline(debRoot)
  await smoke(await installedExecutable(debRoot))

  const rpmRoot = join(scratch, 'rpm')
  await extractRpm(rpm, rpmRoot)
  await verifyOffline(rpmRoot)
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
  await run(executable, ['--smoke-test'], { timeout: 30_000 })
}

async function verifyOffline(directory) {
  if (process.env.DSH_EXPECT_OFFLINE !== '1') return
  const files = await walk(directory)
  const manifestPath = files.find((file) =>
    file.replaceAll('\\', '/').endsWith('/offline/manifest.json'),
  )
  if (!manifestPath) throw new Error(`Full package has no offline/manifest.json under ${directory}`)
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

async function run(command, args, { timeout = 120_000, cwd, createCwd = false } = {}) {
  if (createCwd) await mkdir(cwd, { recursive: true })
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
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

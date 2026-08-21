import { access, chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

const root = process.argv[2]
if (!root) throw new Error('usage: node verify-packaged-app.mjs <tauri-bundle-directory>')

const scratch = await mkdtemp(join(tmpdir(), 'dsh-studio-package-smoke-'))
try {
  const files = await walk(root)
  if (process.platform === 'win32') await verifyWindows(files)
  else if (process.platform === 'darwin') await verifyMac(files)
  else await verifyLinux(files)
} finally {
  await rm(scratch, { recursive: true, force: true })
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
  await smoke(await installedExecutable(msiRoot))

  const nsisRoot = join(scratch, 'nsis')
  // NSIS requires /D to be the final argument. spawn() passes it as one value,
  // so spaces in the temporary path are never interpreted by a shell.
  await run(nsis, ['/S', `/D=${nsisRoot}`])
  await smoke(await installedExecutable(nsisRoot))
  const uninstaller = (await walk(nsisRoot)).find(
    (file) => basename(file).toLowerCase() === 'uninstall.exe',
  )
  if (!uninstaller) throw new Error('NSIS installation contains no uninstaller')
  await run(uninstaller, ['/S'])
  await waitUntilRemoved(nsisRoot)
  console.log('verified MSI extraction and NSIS installation by executing both packaged binaries')
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
  await smoke(await installedExecutable(appImageRoot))

  const debRoot = join(scratch, 'deb')
  await run('dpkg-deb', ['--extract', deb, debRoot])
  await smoke(await installedExecutable(debRoot))

  const rpmRoot = join(scratch, 'rpm')
  await extractRpm(rpm, rpmRoot)
  await smoke(await installedExecutable(rpmRoot))
  console.log('extracted AppImage, DEB and RPM and executed every packaged application binary')
}

async function extractRpm(rpm, directory) {
  await mkdir(directory, { recursive: true })
  await new Promise((resolve, reject) => {
    const unpack = spawn('rpm2cpio', [rpm], { stdio: ['ignore', 'pipe', 'inherit'] })
    const cpio = spawn('cpio', ['-idm', '--quiet'], {
      cwd: directory,
      stdio: [unpack.stdout, 'inherit', 'inherit'],
    })
    let first = null
    unpack.on('error', reject)
    cpio.on('error', reject)
    unpack.on('exit', (code) => {
      if (code !== 0) first = new Error(`rpm2cpio exited with ${code}`)
    })
    cpio.on('exit', (code) => {
      if (first) reject(first)
      else if (code === 0) resolve()
      else reject(new Error(`cpio exited with ${code}`))
    })
  })
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

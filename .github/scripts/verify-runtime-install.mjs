import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const spec = '@deepseek-ai/dsh@0.1.0-rc.8'
const expected = '0.1.0-rc.8'
const directory = await mkdtemp(join(tmpdir(), 'dsh-runtime-contract-'))

try {
  const npm =
    process.platform === 'win32'
      ? {
          command: process.execPath,
          args: [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')],
        }
      : { command: 'npm', args: [] }
  await run(npm.command, [
    ...npm.args,
    'install',
    '--prefix',
    directory,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts=false',
    spec,
  ])
  const packageRoot = join(directory, 'node_modules', '@deepseek-ai', 'dsh')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.version !== expected) {
    throw new Error(`installed ${manifest.version ?? 'unknown'}, expected ${expected}`)
  }
  const entry = join(packageRoot, 'lib', 'bin.js')
  await stat(entry)
  await run(process.execPath, [entry, '--help'], { timeout: 120_000 })
  console.log(`cold-installed and executed ${spec}`)
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

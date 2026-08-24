import { spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export const READY_PREFIX = 'dsh web: '

/** Parse the exact loopback origin accepted by the native supervisor. */
export function parseReadyOrigin(line) {
  if (!line.startsWith(READY_PREFIX)) return undefined
  const candidate = line.slice(READY_PREFIX.length).trim().split(/\s+/u)[0]
  let url
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`harness announced an unparseable URL: ${candidate}`)
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.port === ''
  ) {
    throw new Error(`harness announced an unsafe URL: ${candidate}`)
  }
  return url.origin
}

/** Write only the public profile contract that the product itself bootstraps. */
export async function prepareSmokeProfile(runtimeRoot, dshHome) {
  const profile = join(dshHome, 'profiles', 'web')
  const integrationSource = join(
    runtimeRoot,
    'node_modules',
    '@moresyl',
    'dsh-studio-integration',
  )
  const integrationTarget = join(
    dshHome,
    'profiles',
    'node_modules',
    '@moresyl',
    'dsh-studio-integration',
  )
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(join(integrationTarget, 'lib'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      join(profile, 'package.json'),
      `${JSON.stringify(
        {
          name: 'dsh-profile-web',
          private: true,
          dependencies: {},
          dsh: {
            profile: {
              bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
            },
          },
        },
        undefined,
        2,
      )}\n`,
    ),
    writeFile(join(profile, 'cordis.patch.yml'), '[]\n'),
    writeFile(
      join(profile, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    ),
    ...['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js'].map(
      (relative) => copyFile(join(integrationSource, relative), join(integrationTarget, relative)),
    ),
  ])
  return {
    profile,
    patch: join(integrationSource, 'cordis.patch.yml'),
  }
}

/** Start the real managed CLI and prove its fully composed Web profile serves. */
export async function verifyProfileBoot({
  entry,
  runtimeRoot,
  dshHome,
  timeout = 120_000,
}) {
  const { patch } = await prepareSmokeProfile(runtimeRoot, dshHome)
  const workspace = join(dshHome, 'workspace')
  await mkdir(workspace, { recursive: true })

  const child = spawn(
    process.execPath,
    [
      entry,
      '--profile',
      'web',
      '--patch',
      patch,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    {
      cwd: workspace,
      env: { ...process.env, DSH_HOME: dshHome, DSH_DESKTOP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )

  const output = []
  const remember = (stream, line) => {
    output.push(`[${stream}] ${line}`)
    if (output.length > 200) output.shift()
  }
  const stdout = createInterface({ input: child.stdout })
  const stderr = createInterface({ input: child.stderr })
  stderr.on('line', (line) => remember('stderr', line))

  try {
    const origin = await new Promise((resolve, reject) => {
      let settled = false
      const finish = (work) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        work()
      }
      const timer = setTimeout(
        () => finish(() => reject(bootFailure(`did not announce a port within ${timeout} ms`, output))),
        timeout,
      )
      stdout.on('line', (line) => {
        remember('stdout', line)
        try {
          const announced = parseReadyOrigin(line)
          if (announced !== undefined) finish(() => resolve(announced))
        } catch (error) {
          finish(() => reject(bootFailure(error.message, output)))
        }
      })
      child.once('error', (error) =>
        finish(() => reject(bootFailure(`could not start: ${error.message}`, output))),
      )
      child.once('exit', (code, signal) =>
        finish(() =>
          reject(bootFailure(`closed before readiness with ${code ?? signal}`, output)),
        ),
      )
    })

    const response = await fetch(origin, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'dsh-studio-runtime-contract' },
    })
    if (!response.ok) {
      throw bootFailure(`readiness endpoint returned HTTP ${response.status}`, output)
    }
    return origin
  } finally {
    stdout.close()
    stderr.close()
    await stop(child)
  }
}

function bootFailure(message, output) {
  const tail = output.length === 0 ? '(no harness output)' : output.slice(-40).join('\n')
  return new Error(`${message}\n${tail}`)
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

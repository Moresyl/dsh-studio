import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

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
  const marker = join(dshHome, 'studio-host-contract.json')
  const probePatch = join(dshHome, 'studio-host-contract.patch.yml')
  const integrationSource = join(runtimeRoot, 'node_modules', '@moresyl', 'dsh-studio-integration')
  const integrationTarget = join(
    dshHome,
    'profiles',
    'node_modules',
    '@moresyl',
    'dsh-studio-integration',
  )
  const probeTarget = join(
    dshHome,
    'profiles',
    'node_modules',
    '@moresyl',
    'dsh-studio-host-contract-probe',
  )
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(join(integrationTarget, 'lib'), { recursive: true }),
    mkdir(probeTarget, { recursive: true }),
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
    writeFile(
      join(probeTarget, 'package.json'),
      `${JSON.stringify(
        {
          name: '@moresyl/dsh-studio-host-contract-probe',
          version: '0.0.0',
          private: true,
          type: 'module',
          main: './index.js',
        },
        undefined,
        2,
      )}\n`,
    ),
    writeFile(
      join(probeTarget, 'index.js'),
      `import { writeFileSync } from 'node:fs'\n\n` +
        `export const name = 'dsh-studio-host-contract-probe'\n` +
        `export const inject = ['dshStudioHost']\n\n` +
        `export function apply(ctx, config) {\n` +
        `  const host = ctx.dshStudioHost\n` +
        `  const current = host.profiles.list().find((profile) => profile.name === host.profiles.current.name)\n` +
        `  writeFileSync(config.marker, JSON.stringify({\n` +
        `    protocol: host.protocol,\n` +
        `    studioVersion: host.studio.version,\n` +
        `    harnessVersion: host.harness.version,\n` +
        `    capabilities: host.capabilities,\n` +
        `    restrictions: host.restrictions,\n` +
        `    current,\n` +
        `  }))\n` +
        `}\n`,
    ),
    writeFile(
      probePatch,
      `- insert:\n  - id: dsh-studio-host-contract-probe\n    name: '@moresyl/dsh-studio-host-contract-probe'\n    config:\n      marker: ${JSON.stringify(marker.replaceAll('\\', '/'))}\n`,
    ),
    writeFile(join(profile, 'cordis.patch.yml'), '[]\n'),
    writeFile(
      join(profile, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    ),
    ...['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js'].map((relative) =>
      copyFile(join(integrationSource, relative), join(integrationTarget, relative)),
    ),
  ])
  return {
    profile,
    patch: join(integrationSource, 'cordis.patch.yml'),
    probePatch,
    marker,
  }
}

/** Start the real managed CLI and prove its fully composed Web profile serves. */
export async function verifyProfileBoot({
  entry,
  runtimeRoot,
  dshHome,
  studioVersion,
  harnessVersion,
  timeout = 120_000,
}) {
  const { marker, patch, probePatch, profile } = await prepareSmokeProfile(runtimeRoot, dshHome)
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
      '--patch',
      probePatch,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_DESKTOP: '1',
        DSH_STUDIO_PROFILE: 'web',
        DSH_STUDIO_PROFILE_DIR: profile,
        DSH_STUDIO_VERSION: studioVersion,
        DSH_STUDIO_RUNTIME_VERSION: harnessVersion,
      },
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
        () =>
          finish(() => reject(bootFailure(`did not announce a port within ${timeout} ms`, output))),
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
        finish(() => reject(bootFailure(`closed before readiness with ${code ?? signal}`, output))),
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
    const contract = await waitForContract(marker, 5_000, output)
    if (
      contract.protocol !== 1 ||
      contract.studioVersion !== studioVersion ||
      contract.harnessVersion !== harnessVersion ||
      contract.current?.name !== 'web' ||
      contract.current?.servesWindow !== true ||
      contract.restrictions?.arbitraryCommands !== false ||
      contract.restrictions?.packageMutation !== false ||
      contract.restrictions?.profileMutation !== false
    ) {
      throw bootFailure(
        `Host contract probe returned an incompatible result: ${JSON.stringify(contract)}`,
        output,
      )
    }
    return origin
  } finally {
    stdout.close()
    stderr.close()
    await stop(child)
  }
}

async function waitForContract(marker, timeout, output) {
  const started = Date.now()
  let lastFailure
  while (Date.now() - started < timeout) {
    try {
      return JSON.parse(await readFile(marker, 'utf8'))
    } catch (cause) {
      lastFailure = cause
      await delay(25)
    }
  }
  throw bootFailure(
    `Host contract probe did not produce a valid marker within ${timeout} ms: ${lastFailure?.message ?? 'unknown error'}`,
    output,
  )
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

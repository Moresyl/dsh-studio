/**
 * A stand-in backend, so the README's pictures are of the real application.
 *
 * The screenshots and animations in `assets/` have to show two things that need
 * a phone, a registry and several minutes of npm to happen for real: installing
 * a plugin, and pairing a device. Recreating those screens in a design tool
 * would be a drawing of the product rather than the product, and the first thing
 * to rot the next time a pane is rearranged.
 *
 * So this answers the Rust command surface instead. Everything above it is the
 * shipped application, unmodified and unaware — `media/index.html` loads the
 * capture module before `src/main.tsx`, which is early enough to have the mock
 * in place before the first command goes out.
 *
 * Two rules keep it honest:
 *
 * 1. Nothing here is invented where the real thing was available. The registry
 *    listings, the manifest, and the QR modules are what the live commands
 *    returned; only the parts that identify a machine are replaced, which is the
 *    other half of why this file exists — the previous screenshots were taken on
 *    a real desktop and published a real user's home directory.
 * 2. It is typed against `@/lib/ipc`, and `media` is in `tsconfig.json`'s
 *    `include`. A command that changes shape in Rust breaks the build here
 *    rather than quietly making the pictures a lie.
 */
import { emit } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

import type {
  About,
  Environment,
  InstalledPlugin,
  LogLine,
  LogStream,
  PluginDetail,
  PluginListing,
  PluginState,
  RemoteStatus,
  Status,
} from '@/lib/ipc'

/* -------------------------------------------------------------------------- */
/* A machine that belongs to nobody                                           */
/* -------------------------------------------------------------------------- */

/** Every path below hangs off this, so there is one place to check. */
const HOME = 'C:\\Users\\dev'
const APP_DATA = `${HOME}\\AppData\\Local\\dsh-studio`
const HARNESS_DIR = `${APP_DATA}\\harness`
const PROFILE = 'web'

const environment: Environment = {
  node: {
    path: 'C:\\Program Files\\nodejs\\node.exe',
    version: { major: 24, minor: 19, patch: 0 },
    source: 'system',
  },
  allNodeRuntimes: [
    {
      path: 'C:\\Program Files\\nodejs\\node.exe',
      version: { major: 24, minor: 19, patch: 0 },
      source: 'system',
    },
  ],
  minimumNode: { major: 22, minor: 19, patch: 0 },
  harnessInstalled: true,
  harnessCompatible: true,
  harnessVersion: '0.1.0-rc.8',
  expectedHarnessVersion: '0.1.0-rc.8',
  harnessProblem: null,
  harnessEntry: `${HARNESS_DIR}\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
  workspace: `${HOME}\\projects\\atlas`,
  workspaceAdmission: { state: 'safe', filesystem: 'NTFS', reason: null },
}

const about: About = {
  version: '0.4.0',
  platform: 'windows',
  arch: 'x86_64',
  edition: 'lite',
  appData: APP_DATA,
  harnessDir: HARNESS_DIR,
  profileDir: `${HOME}\\.dsh\\profiles\\${PROFILE}`,
}

/* -------------------------------------------------------------------------- */
/* Mutable world                                                              */
/* -------------------------------------------------------------------------- */

/** Port the harness serves on, in the range the kernel hands out. */
const ORIGIN = 'http://127.0.0.1:53107'
const LAN_ADDRESS = '192.168.1.24'

let status: Status = { phase: 'stopped' }
const lines: LogLine[] = []

/**
 * Two plugins installed already, one of them switched off — the state that shows
 * what the pane is for, rather than an empty list or an all-green one.
 */
const installed: InstalledPlugin[] = [
  {
    name: 'dsh-design-playbook',
    spec: '^0.20.2',
    active: true,
    disabled: false,
    builtin: false,
    marketReceipt: 'demo-market-receipt',
  },
  {
    name: 'dsh-plugin-grok2api-media-tool',
    spec: '^0.7.6',
    active: false,
    disabled: true,
    builtin: false,
    marketReceipt: null,
  },
  {
    name: '@deepseek-ai/dsh-base',
    spec: '',
    active: true,
    disabled: false,
    builtin: true,
    marketReceipt: null,
  },
  {
    name: '@deepseek-ai/dsh-web-app',
    spec: '',
    active: true,
    disabled: false,
    builtin: true,
    marketReceipt: null,
  },
]

const remote: RemoteStatus = {
  open: false,
  addresses: [LAN_ADDRESS, '172.20.10.2'],
  url: null,
  pairingUrl: null,
  qr: null,
  codeSecondsLeft: null,
  codeLifetimeSeconds: 120,
  devices: [],
  active: 0,
  served: 0,
  refused: 0,
}

const profile = (): PluginState => ({
  profile: PROFILE,
  profileDir: about.profileDir,
  initialized: true,
  plugins: [...installed],
  packageManager: true,
})

/* -------------------------------------------------------------------------- */
/* What the registry actually returned                                        */
/* -------------------------------------------------------------------------- */

/**
 * `plugin_search` with an empty box asks npm for `dsh bundle`; these are that
 * search's own results, trimmed to the first screenful and left otherwise
 * untouched — names, versions, publishers, download counts and dates included.
 */
const NPM_LISTING = {
  sourceId: 'npm',
  sourceLabel: 'npm registry',
  installable: true,
  categories: ['dsh'],
  hasIcon: false,
} satisfies Pick<
  PluginListing,
  'sourceId' | 'sourceLabel' | 'installable' | 'categories' | 'hasIcon'
>

const DISCOVER: PluginListing[] = [
  {
    ...NPM_LISTING,
    name: 'dsh-visual-plugin',
    version: '0.2.6',
    description:
      'Vision bridge plugin for DeepSeek Harness: forward user images to a configurable OpenAI-compatible vision model and show results in a Web UI right panel.',
    publisher: 'yihengjiang',
    updated: '2026-08-16T00:00:00.000Z',
    weeklyDownloads: 208,
    link: 'https://www.npmjs.com/package/dsh-visual-plugin',
  },
  {
    ...NPM_LISTING,
    name: '@wsz987/dsh-channels',
    version: '0.2.4',
    description: 'Channel plugin for DeepSeek Harness — multiplex several conversations at once.',
    publisher: 'GitHub Actions',
    updated: '2026-08-16T00:00:00.000Z',
    weeklyDownloads: 81,
    link: 'https://www.npmjs.com/package/@wsz987/dsh-channels',
  },
  {
    ...NPM_LISTING,
    name: '@d4cluvtrain/dsh-plugin-manager',
    version: '0.1.2',
    description: 'Install, list and switch DeepSeek Harness plugins from inside a session.',
    publisher: 'd4cluvtrain',
    updated: '2026-08-17T00:00:00.000Z',
    weeklyDownloads: 226,
    link: 'https://www.npmjs.com/package/@d4cluvtrain/dsh-plugin-manager',
  },
  {
    ...NPM_LISTING,
    name: 'dsh-novelweb',
    version: '0.2.0-beta.1',
    description: 'Long-form writing surface for the harness, distributed as a dsh bundle.',
    publisher: 'emmm2333',
    updated: '2026-08-16T00:00:00.000Z',
    weeklyDownloads: 119,
    link: 'https://www.npmjs.com/package/dsh-novelweb',
  },
  {
    ...NPM_LISTING,
    name: 'dsh-plugin-grok2api-media-tool',
    version: '0.7.6',
    description: 'Media generation tool bundle: images and video through an OpenAI-compatible API.',
    publisher: 'lsjspl',
    updated: '2026-08-16T00:00:00.000Z',
    weeklyDownloads: 40,
    link: 'https://www.npmjs.com/package/dsh-plugin-grok2api-media-tool',
  },
  {
    ...NPM_LISTING,
    name: '@eqman00003/knowlp-rag',
    version: '3.0.6',
    description:
      'Retrieval plugin: index a directory once, then answer from it inside the harness.',
    publisher: 'GitHub Actions',
    updated: '2026-08-16T00:00:00.000Z',
    weeklyDownloads: 421,
    link: 'https://www.npmjs.com/package/@eqman00003/knowlp-rag',
  },
  {
    ...NPM_LISTING,
    name: 'dsh-design-playbook',
    version: '0.20.2',
    description: 'Design review playbook — a bundle of prompts, checklists and report templates.',
    publisher: 'GitHub Actions',
    updated: '2026-08-16T00:00:00.000Z',
    weeklyDownloads: 323,
    link: 'https://www.npmjs.com/package/dsh-design-playbook',
  },
  {
    ...NPM_LISTING,
    name: '@danielng23/dsh-x402-wallet',
    version: '0.1.2',
    description: 'x402 wallet bundle: let a session pay for its own metered HTTP requests.',
    publisher: 'danielng23',
    updated: '2026-08-17T00:00:00.000Z',
    weeklyDownloads: 232,
    link: 'https://www.npmjs.com/package/@danielng23/dsh-x402-wallet',
  },
]

/** `plugin_detail dsh-visual-plugin`, as the registry published it. */
const DETAILS: Record<string, PluginDetail> = {
  'dsh-visual-plugin': {
    name: 'dsh-visual-plugin',
    version: '0.2.6',
    description:
      'Vision bridge plugin for DeepSeek Harness: when the main model has no vision, forward user images to a configurable OpenAI-compatible vision model and show results in a Web UI right panel. Host tool + browser half, distributed as a dsh bundle.',
    license: 'MIT',
    homepage: 'https://github.com/yihengjiang/dsh-visual-plugin#readme',
    repository: 'https://github.com/yihengjiang/dsh-visual-plugin',
    bundle: true,
    dependencies: [],
    installSpec: 'dsh-visual-plugin@0.2.6',
    source: 'https://registry.npmjs.org',
    compatibility: { state: 'unknown' },
    integrity: 'sha512-demo',
    bundlePatch: {},
    lifecycleScripts: [],
    deprecated: null,
    repositoryVerified: true,
    integrityVerified: true,
  },
}

const detailFor = (name: string): PluginDetail => {
  const known = DETAILS[name]
  if (known) return known
  const listing = DISCOVER.find((entry) => entry.name === name)
  return {
    name,
    version: listing?.version ?? '1.0.0',
    installSpec: `${name}@${listing?.version ?? '1.0.0'}`,
    source: 'https://registry.npmjs.org',
    compatibility: { state: 'unknown' },
    integrity: 'sha512-demo',
    bundlePatch: {},
    description: listing?.description ?? '',
    license: 'MIT',
    homepage: listing?.link ?? null,
    repository: listing?.link ?? null,
    bundle: true,
    dependencies: [],
    lifecycleScripts: [],
    deprecated: null,
    repositoryVerified: true,
    integrityVerified: true,
  }
}

/**
 * A 33 × 33 symbol for `http://192.168.1.24:53107/?k=<32 hex>`, generated at
 * error correction level M — the same encoder settings as `remote/qr.rs`, so it
 * scans, and scans to a URL that goes nowhere.
 */
const QR_SIZE = 33
const QR_PACKED =
  'AfzkL3+CFY6g3XHXl26wOIu3XQM12Ch+yg/1VVX8AgQSAXxv8HwkEFX30YTSJQk8DbvL4xsJgRUDOx5/WVS68nhXCO/a0Dl18pf2nZPCZb1Ro9OlUsxziNtp1ix0aSG6QNifHVzf0fMAnBSL/ybB1SC8rSK3Vd0fq6/BIb3VvheiCMp06f320To='
const PAIRING_URL = `http://${LAN_ADDRESS}:53107/?k=6f2a91c4d7e83b05a1f60c9d8e472b13`

const qrModules = (): boolean[] => {
  const bytes = atob(QR_PACKED)
  const modules: boolean[] = []
  for (let index = 0; index < QR_SIZE * QR_SIZE; index += 1) {
    const byte = bytes.charCodeAt(index >> 3)
    modules.push((byte & (0x80 >> (index & 7))) !== 0)
  }
  return modules
}

/* -------------------------------------------------------------------------- */
/* Emitting what the supervisor would emit                                    */
/* -------------------------------------------------------------------------- */

const say = (line: string, stream: LogStream = 'stdout'): void => {
  lines.push({ stream, line })
  void emit('harness://event', { kind: 'log', stream, line })
}

const setStatus = (next: Status) => {
  status = next
  void emit('harness://event', { kind: 'status', ...next })
}

const remoteChanged = () => void emit('remote://changed')

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Two painted frames, which is when a React state change is on screen. */
export const settle = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })

/* -------------------------------------------------------------------------- */
/* Beats                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A pause a capture can stand still in.
 *
 * Installing takes as long as npm takes, which is the one thing a capture must
 * not depend on: a spinner is a frame of the animation, and the frame after it
 * has to be the same pixels plus one more log line. So every point a command
 * would wait at is a beat, and while the world is held each beat parks until it
 * is let through — one `pass()` per frame.
 */
let holding = false
let parked: (() => void) | null = null

const beat = async (ms: number): Promise<void> => {
  if (!holding) {
    await wait(ms)
    return
  }
  await new Promise<void>((resolve) => {
    parked = resolve
  })
}

const until = async (ready: () => boolean) => {
  for (let attempt = 0; attempt < 150 && !ready(); attempt += 1) await wait(16)
}

export const hold = (): void => {
  holding = true
}

/** Let the parked command run to its next beat, and wait for the redraw. */
export const pass = async (): Promise<void> => {
  await until(() => parked !== null)
  const go = parked
  parked = null
  go?.()
  await settle()
}

/** Stop holding, and let anything parked run to the end. */
export const free = async (): Promise<void> => {
  holding = false
  const go = parked
  parked = null
  go?.()
  await settle()
}

/* -------------------------------------------------------------------------- */
/* Flows                                                                      */
/* -------------------------------------------------------------------------- */

/** The lines a harness prints between `start` and serving. */
const BOOT: string[] = [
  'dsh 0.1.0-rc.6 starting',
  `profile ${PROFILE} · 4 layers composed`,
  'bundle @deepseek-ai/dsh-web-app ready',
  'bundle dsh-design-playbook ready',
  `listening on ${ORIGIN}`,
]

export const serve = async (): Promise<string> => {
  setStatus({ phase: 'starting' })
  for (const line of BOOT) {
    await wait(90)
    say(line)
  }
  setStatus({ phase: 'ready', origin: ORIGIN, pid: 24188 })
  return ORIGIN
}

const stop = (): void => {
  say('received stop; draining 0 connections')
  setStatus({ phase: 'stopped' })
  if (remote.open) closeDoor()
}

/** What npm prints while it resolves and links one package. */
const ADD_LOG: string[] = [
  'npm http fetch GET 200 https://registry.npmjs.org/dsh-visual-plugin 214ms',
  'npm http fetch GET 200 https://registry.npmjs.org/sharp 128ms',
  'npm http cache GET 200 https://registry.npmjs.org/undici 2ms',
  'npm http fetch GET 200 https://registry.npmjs.org/zod 96ms',
  'added 4 packages in 3s',
]

const add = async (spec: string): Promise<PluginState> => {
  const name = spec.replace(/@[^@/]+$/, '') || spec
  say(`installing ${name} into profile ${PROFILE}`)
  for (const line of ADD_LOG) {
    await beat(150)
    say(line)
  }
  await beat(200)
  if (!installed.some((plugin) => plugin.name === name)) {
    installed.unshift({
      name,
      spec: `^${detailFor(name).version}`,
      active: true,
      disabled: false,
      builtin: false,
      marketReceipt: null,
    })
  }
  say(`${spec} written to the profile; restart the harness to apply it`)
  return profile()
}

const remove = async (name: string): Promise<PluginState> => {
  say(`removing ${name} from profile ${PROFILE}`)
  await beat(320)
  say('removed 4 packages in 1s')
  await beat(160)
  const index = installed.findIndex((plugin) => plugin.name === name)
  if (index >= 0) installed.splice(index, 1)
  say(`${name} written to the profile; restart the harness to apply it`)
  return profile()
}

const switchPlugin = (name: string, enabled: boolean): PluginState => {
  const plugin = installed.find((entry) => entry.name === name)
  if (plugin) {
    plugin.disabled = !enabled
    plugin.active = enabled
  }
  say(`${name} switched ${enabled ? 'on' : 'off'} in the profile; restart the harness to apply it`)
  return profile()
}

const openDoor = async (): Promise<RemoteStatus> => {
  await beat(260)
  remote.open = true
  remote.url = `http://${LAN_ADDRESS}:53107`
  remote.pairingUrl = PAIRING_URL
  remote.qr = { size: QR_SIZE, modules: qrModules() }
  remote.codeSecondsLeft = remote.codeLifetimeSeconds
  say(`remote access open on ${remote.url}; pairing code valid for 120s`)
  remoteChanged()
  return { ...remote }
}

function closeDoor(): RemoteStatus {
  remote.open = false
  remote.url = null
  remote.pairingUrl = null
  remote.qr = null
  remote.codeSecondsLeft = null
  remote.devices = []
  remote.active = 0
  say('remote access closed')
  remoteChanged()
  return { ...remote }
}

const forget = (id: string): RemoteStatus => {
  remote.devices = remote.devices.filter((device) => device.id !== id)
  remote.active = Math.max(0, remote.active - 1)
  say(`device ${id} forgotten; its connections were closed`)
  remoteChanged()
  return { ...remote }
}

/**
 * A phone that scanned the code and connected.
 *
 * Pairing spends the code — `access.rs` sets it to `None` on success, and its
 * own test says so — so the symbol goes with it and the panel falls to the
 * lapsed tile. That is the state a real pairing leaves behind.
 */
export const pair = (label: string): void => {
  remote.devices = [
    ...remote.devices,
    {
      id: `d${remote.devices.length + 1}`,
      label,
      pairedSecondsAgo: 2,
      lastSeenSecondsAgo: 0,
    },
  ]
  remote.active += 1
  remote.served += 3
  remote.codeSecondsLeft = null
  remote.pairingUrl = null
  remote.qr = null
  say(`${label} paired from ${LAN_ADDRESS}`)
  remoteChanged()
}

/** Wind the code down, the way the panel's own second-by-second read would. */
export const tick = (seconds: number): void => {
  remote.codeSecondsLeft = seconds
  remoteChanged()
}

/* -------------------------------------------------------------------------- */
/* The mock                                                                   */
/* -------------------------------------------------------------------------- */

const text = (args: unknown, key: string): string => {
  if (typeof args !== 'object' || args === null) return ''
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

const flag = (args: unknown, key: string): boolean => {
  if (typeof args !== 'object' || args === null) return false
  return (args as Record<string, unknown>)[key] === true
}

/** Answer every command the application makes, for as long as the page lives. */
export function answerCommands(): void {
  mockWindows('main')

  mockIPC(
    (command, args): unknown => {
      switch (command) {
        /* Harness */
        case 'harness_environment':
          return environment
        case 'harness_status':
          return status
        case 'harness_log':
          return [...lines]
        case 'harness_start':
          return serve()
        case 'harness_stop':
          return stop()
        case 'harness_install':
          return beat(600)

        /* Node */
        case 'node_provision':
          return beat(600).then(() => environment.node)

        /* Remote */
        case 'remote_status':
          return { ...remote }
        case 'remote_open':
          return openDoor()
        case 'remote_close':
          return closeDoor()
        case 'remote_renew':
          return openDoor()
        case 'remote_forget':
          return forget(text(args, 'id'))

        /* Plugins */
        case 'plugin_state':
          return profile()
        case 'plugin_search': {
          const query = text(args, 'query').trim().toLowerCase()
          if (query.length === 0) return DISCOVER
          return DISCOVER.filter(
            (entry) =>
              entry.name.toLowerCase().includes(query) ||
              entry.description.toLowerCase().includes(query),
          )
        }
        case 'plugin_detail':
          return beat(220).then(() => detailFor(text(args, 'name')))
        case 'plugin_add':
          return add(text(args, 'spec'))
        case 'plugin_remove':
          return remove(text(args, 'name'))
        case 'plugin_switch':
          return switchPlugin(text(args, 'name'), flag(args, 'enabled'))

        /* About */
        case 'app_about':
          return about

        /* Plugins of the framework itself, which the app also talks to. */
        case 'plugin:updater|check':
          return null
        case 'plugin:window|is_maximized':
        case 'plugin:window|is_fullscreen':
          return false
        case 'plugin:window|scale_factor':
          return 1
        default:
          // Window controls, `openUrl`, `revealItemInDir`: called for effect, and
          // the effect is a window manager this page does not have.
          return null
      }
    },
    { shouldMockEvents: true },
  )
}

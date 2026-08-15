/**
 * Typed view of the Rust command surface.
 *
 * These declarations mirror `src-tauri/src/harness`; when a shape changes there
 * it must change here, because nothing else keeps the two sides honest.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface NodeVersion {
  major: number
  minor: number
  patch: number
}

export type NodeSource = 'path' | 'nvm' | 'fnm' | 'volta' | 'system'

export interface NodeInstallation {
  path: string
  version: NodeVersion
  source: NodeSource
}

export interface Environment {
  node: NodeInstallation | null
  allNodeRuntimes: NodeInstallation[]
  minimumNode: NodeVersion
  harnessInstalled: boolean
  harnessEntry: string
  workspace: string
}

export type Status =
  | { phase: 'stopped' }
  | { phase: 'starting' }
  | { phase: 'ready'; origin: string; pid: number }
  | { phase: 'restarting'; attempt: number; delayMs: number }
  | { phase: 'failed'; reason: string }

export type LogStream = 'stdout' | 'stderr'

export interface LogLine {
  stream: LogStream
  line: string
}

/**
 * Supervisor events arrive internally tagged, so a status event is a `Status`
 * with a `kind` alongside its `phase` rather than a wrapper around one.
 */
export type HarnessEvent = ({ kind: 'status' } & Status) | ({ kind: 'log' } & LogLine)

/** Channel `lib.rs` emits supervisor events on. */
const EVENT_CHANNEL = 'harness://event'

export const formatVersion = (version: NodeVersion): string =>
  `${version.major}.${version.minor}.${version.patch}`

/**
 * Whether `version` satisfies `minimum`, ordered the way `Version` orders itself
 * in Rust. The backend already picked a runtime with this rule; the UI needs it
 * again only to say which of the others were rejected and why.
 */
export function isAtLeast(version: NodeVersion, minimum: NodeVersion): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major
  if (version.minor !== minimum.minor) return version.minor > minimum.minor
  return version.patch >= minimum.patch
}

export const environment = (): Promise<Environment> => invoke('harness_environment')

export const status = (): Promise<Status> => invoke('harness_status')

/** Start the harness; resolves with the origin it is serving on. */
export const start = (): Promise<string> => invoke('harness_start')

export const stop = (): Promise<void> => invoke('harness_stop')

/** Install the harness, or replace it with the latest release. */
export const install = (): Promise<void> => invoke('harness_install')

export const log = (): Promise<LogLine[]> => invoke('harness_log')

/** Subscribe to supervisor status changes and log output. */
export const onHarnessEvent = (handler: (event: HarnessEvent) => void): Promise<UnlistenFn> =>
  listen<HarnessEvent>(EVENT_CHANNEL, (message) => handler(message.payload))

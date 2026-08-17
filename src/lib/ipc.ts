/**
 * Typed view of the Rust command surface.
 *
 * These declarations mirror `src-tauri/src`; when a shape changes there it must
 * change here, because nothing else keeps the two sides honest.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface NodeVersion {
  major: number
  minor: number
  patch: number
}

/** `managed` is a runtime this application downloaded; the rest were already here. */
export type NodeSource = 'path' | 'nvm' | 'fnm' | 'volta' | 'system' | 'managed'

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

/* -------------------------------------------------------------------------- */
/* Node runtime                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How far along an in-app Node install is.
 *
 * Every phase past the first names its own release, so nothing here has to be
 * read in sequence — see `Progress` in `src-tauri/src/node/mod.rs`.
 *
 * `total` is whatever the mirror declared, so it can be missing: a chunked reply
 * has no content length, and a progress bar that invents one would be a lie the
 * moment it reached the end and kept going.
 */
export type NodeProgress =
  | { phase: 'resolving' }
  | { phase: 'chosen'; version: string; url: string }
  | { phase: 'downloading'; version: string; received: number; total: number | null }
  | { phase: 'verifying'; version: string }
  | { phase: 'extracting'; version: string }
  | { phase: 'installed'; version: string }

/** Channel `node/commands.rs` reports install progress on. */
const NODE_CHANNEL = 'node://progress'

/**
 * Download and install a Node runtime into this application's own directory.
 *
 * Resolves once the runtime has answered `--version`, so the environment can be
 * re-read straight afterwards and will show it.
 */
export const nodeProvision = (): Promise<NodeInstallation> => invoke('node_provision')

export const onNodeProgress = (handler: (progress: NodeProgress) => void): Promise<UnlistenFn> =>
  listen<NodeProgress>(NODE_CHANNEL, (message) => handler(message.payload))

/* -------------------------------------------------------------------------- */
/* Remote access                                                              */
/* -------------------------------------------------------------------------- */

/** A QR symbol as `size` × `size` modules, row-major, true meaning dark. */
export interface QrMatrix {
  size: number
  modules: boolean[]
}

/** A phone that has paired and has not been forgotten. */
export interface RemoteDevice {
  /** Names the device to `remoteForget`. A handle, not a secret. */
  id: string
  /** What it called itself, or null when it said nothing useful. */
  label: string | null
  pairedSecondsAgo: number
  lastSeenSecondsAgo: number
}

export interface RemoteStatus {
  open: boolean
  /** Addresses this machine could be reached on, open or not. */
  addresses: string[]
  /** Where the harness is reachable, without any secret in it. */
  url: string | null
  /** The one URL that pairs a device. Never logged, never persisted. */
  pairingUrl: string | null
  qr: QrMatrix | null
  /** Seconds the code on screen has left; null once there is no live one. */
  codeSecondsLeft: number | null
  /** How long a fresh code gets, so the countdown can draw what is left of it. */
  codeLifetimeSeconds: number
  devices: RemoteDevice[]
  active: number
  served: number
  refused: number
}

/** Channel `lib.rs` pokes when a remote connection opens or closes. */
const REMOTE_CHANNEL = 'remote://changed'

export const remoteStatus = (): Promise<RemoteStatus> => invoke('remote_status')

/** Open a door in front of the harness. Requires it to be serving. */
export const remoteOpen = (): Promise<RemoteStatus> => invoke('remote_open')

export const remoteClose = (): Promise<RemoteStatus> => invoke('remote_close')

/** Put a new pairing code on screen. Paired devices are untouched. */
export const remoteRenew = (): Promise<RemoteStatus> => invoke('remote_renew')

/** Forget one device, ending anything it has open. */
export const remoteForget = (id: string): Promise<RemoteStatus> => invoke('remote_forget', { id })

/**
 * Subscribe to connection changes.
 *
 * The signal carries nothing on purpose — the panel asks for the numbers itself,
 * so a coalesced notification costs a redraw rather than a wrong count.
 */
export const onRemoteChange = (handler: () => void): Promise<UnlistenFn> =>
  listen(REMOTE_CHANNEL, () => handler())

/* -------------------------------------------------------------------------- */
/* Plugins                                                                    */
/* -------------------------------------------------------------------------- */

export interface InstalledPlugin {
  name: string
  /** The range recorded in the profile manifest, empty for an in-box bundle. */
  spec: string
  /** Whether the package's profile patch is in the layer stack. */
  active: boolean
  /**
   * Installed, but taken out of the layer stack by the user. Different from a
   * package that was never in it: this one comes back without a download.
   */
  disabled: boolean
  /** Part of the profile template, so never removable from here. */
  builtin: boolean
}

export interface PluginState {
  profile: string
  profileDir: string
  /** False until the harness has created the profile for the first time. */
  initialized: boolean
  plugins: InstalledPlugin[]
  /** Whether a package manager is reachable without installing one first. */
  packageManager: boolean
}

export interface PluginListing {
  name: string
  version: string
  description: string
  publisher: string
  /** ISO timestamp of the last publish. */
  updated: string
  weeklyDownloads: number
  link: string | null
}

export interface PluginDetail {
  name: string
  version: string
  description: string
  license: string
  homepage: string | null
  repository: string | null
  /** Whether the manifest declares a profile patch — a plugin, not a library. */
  bundle: boolean
  dependencies: string[]
}

export const pluginState = (): Promise<PluginState> => invoke('plugin_state')

export const pluginSearch = (query: string): Promise<PluginListing[]> =>
  invoke('plugin_search', { query })

export const pluginDetail = (name: string): Promise<PluginDetail> =>
  invoke('plugin_detail', { name })

/** Install into the hosted profile; resolves with the profile afterwards. */
export const pluginAdd = (spec: string): Promise<PluginState> => invoke('plugin_add', { spec })

export const pluginRemove = (name: string): Promise<PluginState> =>
  invoke('plugin_remove', { name })

/**
 * Take an installed plugin out of the layer stack, or put it back.
 *
 * Nothing is fetched and nothing is deleted, so unlike `pluginAdd` this answers
 * immediately — and unlike `pluginRemove` it is undone by asking for the
 * opposite.
 */
export const pluginSwitch = (name: string, enabled: boolean): Promise<PluginState> =>
  invoke('plugin_switch', { name, enabled })

/* -------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* -------------------------------------------------------------------------- */

/** One profile: a directory, a layer stack, and whatever was installed into it. */
export interface Profile {
  name: string
  dir: string
  /** False until a manifest has been written for it. */
  initialized: boolean
  /** A name the harness ships a template for, and re-creates if it goes. */
  shipped: boolean
  /**
   * Whether it carries the bundles that serve this window. Reported, never
   * enforced: what boots is the harness's call, and the shell only has to make
   * sure the answer is not a surprise.
   */
  servesWindow: boolean
  /** Plugins installed into it, the bundles it came with excluded. */
  plugins: number
  disabled: number
}

export interface Roster {
  profiles: Profile[]
  selected: string
  /** The directory the profiles live in, shown because a profile is a directory. */
  root: string
}

/** How one package stands in one profile. */
export type Standing = 'absent' | 'active' | 'disabled' | 'library' | 'builtin'

/** One package, and what two profiles say about it. */
export interface Difference {
  name: string
  left: Standing
  right: Standing
  /** The range each side records. Two profiles can run the same plugin at different versions. */
  leftSpec: string
  rightSpec: string
  same: boolean
}

export interface Comparison {
  left: string
  right: string
  /** Already sorted with what differs first. */
  rows: Difference[]
  differences: number
}

/**
 * A profile as a file.
 *
 * A declaration and not an archive: what a profile has is packages from a
 * registry and layers from the installation, so the file records what was asked
 * for and the import asks for it again.
 */
export interface Declaration {
  kind: string
  version: number
  /** The profile it came from, offered as the name to import it under. */
  name: string
  /** Plugins as name → range. */
  plugins: Record<string, string>
  disabled: string[]
  /** The profile's own patch layer, verbatim. */
  patch: string
}

export const profileRoster = (): Promise<Roster> => invoke('profile_roster')

/**
 * Point this window at another profile.
 *
 * Records the choice and nothing else. The layer stack is composed at boot, so
 * a running harness keeps running what it started with until it is restarted.
 */
export const profileSelect = (name: string): Promise<Roster> => invoke('profile_select', { name })

export const profileCreate = (name: string): Promise<Roster> => invoke('profile_create', { name })

/** Copy a profile, plugins and all. Installs, so it can take a while. */
export const profileDuplicate = (source: string, name: string): Promise<Roster> =>
  invoke('profile_duplicate', { source, name })

export const profileRename = (from: string, to: string): Promise<Roster> =>
  invoke('profile_rename', { from, to })

/** Delete a profile and everything in it. */
export const profileRemove = (name: string): Promise<Roster> => invoke('profile_remove', { name })

export const profileCompare = (left: string, right: string): Promise<Comparison> =>
  invoke('profile_compare', { left, right })

/** Write a profile out to a path the user picked. */
export const profileExport = (name: string, path: string): Promise<void> =>
  invoke('profile_export', { name, path })

/** Read an exported profile without importing it, so it can be shown first. */
export const profileDeclaration = (path: string): Promise<Declaration> =>
  invoke('profile_declaration', { path })

export const profileImport = (path: string, name: string): Promise<Roster> =>
  invoke('profile_import', { path, name })

/* -------------------------------------------------------------------------- */
/* Agent presets                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One of the agents the harness can start a session as.
 *
 * `name` and `description` are the harness's own words, in whatever language it
 * shipped them in — not translated here, because a preset the user wrote gets
 * shown the same way and inventing text for someone else's preset would be worse
 * than showing theirs. Both are absent when the preset carries no readable
 * metadata, and then the id is what there is to show.
 */
export interface AgentPreset {
  id: string
  name: string | null
  description: string | null
  /** False for one the user authored in their own preset directory. */
  shipped: boolean
}

export interface PresetRoster {
  /** Already in the order the harness lists them in. */
  presets: AgentPreset[]
  /** What new sessions start as, which may name a preset that is no longer there. */
  default: string | null
}

export const presetRoster = (): Promise<PresetRoster> => invoke('preset_roster')

/**
 * Choose what new sessions start as.
 *
 * Safe while the harness is running: it re-reads the choice for every session it
 * creates, so this changes the next one and leaves open ones alone.
 */
export const presetChoose = (id: string): Promise<PresetRoster> => invoke('preset_choose', { id })

/* -------------------------------------------------------------------------- */
/* Terminal                                                                   */
/* -------------------------------------------------------------------------- */

/** One shell, running under a pty this window owns. */
export interface TerminalSession {
  /** Handle for every other terminal command. Never reused within a run. */
  id: string
  /** What is running, for the tab: `pwsh`, `bash`, `fish`. */
  label: string
  cwd: string
}

/** Output from one shell, already decoded on the Rust side. */
export interface TerminalOutput {
  id: string
  data: string
}

/** A shell that has finished. */
export interface TerminalExit {
  id: string
  /** Null when a signal ended it rather than an exit. */
  code: number | null
}

/** Channels `terminal/mod.rs` emits on. */
const TERMINAL_OUTPUT = 'terminal://output'
const TERMINAL_EXIT = 'terminal://exit'

/**
 * Open a shell, sized to the pane that is about to show it.
 *
 * The size is not a detail that can be corrected afterwards: a shell reads it
 * once, at startup, and a prompt drawn for the wrong width stays wrong until
 * something redraws it.
 */
export const terminalOpen = (rows: number, cols: number): Promise<TerminalSession> =>
  invoke('terminal_open', { rows, cols })

export const terminalWrite = (id: string, data: string): Promise<void> =>
  invoke('terminal_write', { id, data })

export const terminalResize = (id: string, rows: number, cols: number): Promise<void> =>
  invoke('terminal_resize', { id, rows, cols })

/** End a shell. The exit event is what confirms it, not this promise. */
export const terminalClose = (id: string): Promise<void> => invoke('terminal_close', { id })

/** Shells that are still running, so a reloaded window can find them again. */
export const terminalList = (): Promise<TerminalSession[]> => invoke('terminal_list')

export const onTerminalOutput = (handler: (output: TerminalOutput) => void): Promise<UnlistenFn> =>
  listen<TerminalOutput>(TERMINAL_OUTPUT, (message) => handler(message.payload))

export const onTerminalExit = (handler: (exit: TerminalExit) => void): Promise<UnlistenFn> =>
  listen<TerminalExit>(TERMINAL_EXIT, (message) => handler(message.payload))

/* -------------------------------------------------------------------------- */
/* Session history                                                            */
/* -------------------------------------------------------------------------- */

/** Whose a line was — see `Role` in `src-tauri/src/sessions/mod.rs`. */
export type Role = 'user' | 'assistant' | 'tool' | 'context'

/** What a session spent, kept apart because cached input is not billed as fresh. */
export interface Tokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** What one model was asked for inside one session. */
export interface Spend {
  /** Empty when the log never named one. */
  model: string
  tokens: Tokens
}

/** A session, as much of it as fits in a list. */
export interface SessionCard {
  id: string
  /** The directory it ran in, empty when the harness recorded none. */
  project: string
  started: number
  touched: number
  title: string
  turns: number
  models: string[]
  tokens: Tokens
  /** The same spend, split by which model did it. Always sums back to `tokens`. */
  byModel: Spend[]
  /** Opened by an agent for its own work rather than by a person. */
  delegated: boolean
  bytes: number
}

export interface SessionLine {
  seq: number
  time: number
  role: Role
  /** What was run, on the lines that are a tool's doing. */
  tool: string | null
  text: string
}

export interface SessionTranscript {
  card: SessionCard
  lines: SessionLine[]
}

export interface Shelved {
  cards: SessionCard[]
  /** Sessions whose text is in memory right now, of the ones listed. */
  loaded: number
}

/**
 * A matching line, already cut into the three pieces that rebuild it.
 *
 * Sent this way rather than as an offset because the two sides do not agree on
 * what an offset is — Rust counts bytes and JavaScript counts UTF-16 code units.
 */
export interface SessionMark {
  seq: number
  time: number
  role: Role
  tool: string | null
  before: string
  hit: string
  after: string
}

export interface SessionHit {
  card: SessionCard
  /** How many lines matched, which is how well the session answered. */
  matches: number
  marks: SessionMark[]
}

/** Every session the harness has run on this machine, newest first. */
export const sessionRoster = (): Promise<Shelved> => invoke('session_roster')

/**
 * The sessions a query describes, best answer first.
 *
 * A session answers when every term appears somewhere in it, not necessarily in
 * one line — the file you named and the error you got are usually messages apart.
 */
export const sessionSearch = (query: string, project?: string): Promise<SessionHit[]> =>
  invoke('session_search', { query, project: project ?? null })

export const sessionRead = (id: string): Promise<SessionTranscript> =>
  invoke('session_read', { id })

/* -------------------------------------------------------------------------- */
/* Window                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Move the window's material into the given light or dark.
 *
 * A no-op where there is no material, so the caller does not have to know. Worth
 * the round trip even though the stylesheet has already changed: on Windows the
 * Mica attributes carry the frame's dark-mode flag with them, and that flag is
 * what colours the resize border and the snap-layouts flyout — parts of the
 * window CSS cannot reach.
 */
export const windowMaterial = (dark: boolean): Promise<void> => invoke('window_material', { dark })

/* -------------------------------------------------------------------------- */
/* Desktop service interface                                                  */
/* -------------------------------------------------------------------------- */

/** A `dsh://` link, already taken apart — see `src-tauri/src/desktop/mod.rs`. */
export interface DesktopLink {
  url: string
  /** Host and path as one path, slashes trimmed: `profile/lab`. */
  route: string
  query: Record<string, string>
}

/** What the shell tells a frame about the desktop it is running on. */
export interface DesktopOffer {
  protocol: number
  app: string
  version: string
  platform: string
  /** The URL scheme that reaches this app from anywhere on the machine. */
  scheme: string
  capabilities: string[]
  /** A link that arrived before there was anything to hand it to, if one did. */
  link: DesktopLink | null
}

/** Channel `desktop/mod.rs` forwards `dsh://` links on. */
const LINK_CHANNEL = 'desktop://link'

/**
 * Describe the desktop, and take any link that was waiting for a listener.
 *
 * Taken and not copied: a link is an instruction to carry out once, so asking
 * twice answers the second caller with nothing.
 */
export const desktopOffer = (): Promise<DesktopOffer> => invoke('desktop_offer')

export const desktopNotify = (title: string, body: string): Promise<void> =>
  invoke('desktop_notify', { title, body })

/** Put a count on the tray and the taskbar, or zero to take it off. */
export const desktopBadge = (count: number): Promise<void> => invoke('desktop_badge', { count })

export const onDesktopLink = (handler: (link: DesktopLink) => void): Promise<UnlistenFn> =>
  listen<DesktopLink>(LINK_CHANNEL, (message) => handler(message.payload))

/* -------------------------------------------------------------------------- */
/* About                                                                      */
/* -------------------------------------------------------------------------- */

export interface About {
  version: string
  platform: string
  arch: string
  appData: string
  harnessDir: string
  profileDir: string
}

export const about = (): Promise<About> => invoke('app_about')

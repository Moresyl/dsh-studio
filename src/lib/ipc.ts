/**
 * Typed view of the Rust command surface.
 *
 * These declarations mirror `src-tauri/src`; when a shape changes there it must
 * change here, because nothing else keeps the two sides honest.
 */
import { invoke } from '@tauri-apps/api/core'
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'

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
  /** The managed package is exactly the upstream family this release tested. */
  harnessCompatible: boolean
  harnessVersion: string | null
  expectedHarnessVersion: string
  /** An interrupted install that could not be recovered automatically. */
  harnessProblem: string | null
  harnessEntry: string
  workspace: string
  workspaceAdmission: {
    state: 'safe' | 'warning' | 'blocked'
    filesystem: string | null
    reason: string | null
  }
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

/** Persist the exact discovered runtime that the next harness start should use. */
export const nodeSelect = (path: string): Promise<NodeInstallation> =>
  invoke('node_select', { path })

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

/** Validate and remember the working directory used by the next Harness start. */
export const workspaceSelect = (path: string): Promise<Environment['workspaceAdmission']> =>
  invoke('workspace_select', { path })

/** Inspect a candidate without changing the working directory for the next start. */
export const workspaceInspect = (path: string): Promise<Environment['workspaceAdmission']> =>
  invoke('workspace_inspect', { path })

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
  /** Durable receipt id when installed through a catalog. */
  marketReceipt: string | null
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
  sourceId: string
  sourceLabel: string
  installable: boolean
  categories: string[]
  hasIcon: boolean
}

export type PluginSort = 'relevance' | 'updated' | 'name' | 'downloads'

export interface PluginPage {
  items: PluginListing[]
  categories: string[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  /** Unix seconds when this source/query index was fetched. */
  indexedAt: number
}

export interface CatalogSource {
  id: string
  label: string
  kind: 'npm' | 'reviewed-http' | 'standard-http-v1'
  endpoint: string | null
  builtIn: boolean
  active: boolean
}

/** Fresh native conformance report for one bounded discovery source. */
export interface CatalogHealth {
  sourceId: string
  contract: string
  checkedAt: number
  items: number
  installable: number
  latencyMs: number
  warnings: string[]
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
  installSpec: string
  source: string
  compatibility:
    | { state: 'compatible'; requirement: string }
    | { state: 'unknown' }
    | { state: 'incompatible'; requirement: string; reason: string }
  integrity: string | null
  bundlePatch: unknown | null
  lifecycleScripts: string[]
  deprecated: string | null
  repositoryVerified: boolean
  integrityVerified: boolean
}

export const pluginState = (): Promise<PluginState> => invoke('plugin_state')

export interface PluginRecoveryNotice {
  generation: string
  profile: string
  operation: string
  subject: string
  restored: boolean
  detail: string
  retry:
    | {
        kind: 'add'
        spec: string
        sourceId: string
        itemId: string
        displayName: string
      }
    | { kind: 'remove'; name: string }
    | null
}

export const pluginRecoveryNotice = (): Promise<PluginRecoveryNotice | null> =>
  invoke('plugin_recovery_notice')

export const pluginRecoveryAcknowledge = (): Promise<void> => invoke('plugin_recovery_acknowledge')

export const pluginRecoveryRetry = (generation: string): Promise<void> =>
  invoke('plugin_recovery_retry', { generation })

export const pluginSearch = (
  query: string,
  category: string | null,
  sort: PluginSort,
  page: number,
  refresh = false,
): Promise<PluginPage> => invoke('plugin_search', { query, category, sort, page, refresh })

export const pluginDetail = (
  sourceId: string,
  name: string,
  version: string,
): Promise<PluginDetail> => invoke('plugin_detail', { sourceId, name, version })

export interface PluginMedia {
  dataUrl: string
}

export const pluginMedia = (
  sourceId: string,
  name: string,
  version: string,
): Promise<PluginMedia | null> => invoke('plugin_media', { sourceId, name, version })

export const pluginSources = (): Promise<CatalogSource[]> => invoke('plugin_sources')

export const pluginSourceHealth = (id: string): Promise<CatalogHealth> =>
  invoke('plugin_source_health', { id })

export const pluginSourceSelect = (id: string): Promise<CatalogSource[]> =>
  invoke('plugin_source_select', { id })

export const pluginSourceAdd = (label: string, endpoint: string): Promise<CatalogSource[]> =>
  invoke('plugin_source_add', { label, endpoint })

export const pluginSourceRemove = (id: string): Promise<CatalogSource[]> =>
  invoke('plugin_source_remove', { id })

/** Install into the hosted profile; resolves with the profile afterwards. */
export interface PluginInstallPreview {
  token: string
  expiresInSeconds: number
}

export const pluginPreview = (
  spec: string,
  sourceId: string,
  itemId: string,
  displayName: string,
): Promise<PluginInstallPreview> =>
  invoke('plugin_preview', { spec, sourceId, itemId, displayName })

export const pluginAdd = (token: string): Promise<PluginState> => invoke('plugin_add', { token })

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

/** A plugin archive on this machine, as its own manifest describes it. */
export interface ArchivePackage {
  name: string
  version: string
  description: string
  /** Whether it declares a profile patch — a plugin, not just a package. */
  bundle: boolean
  /** The file it was read out of. */
  path: string
  bytes: number
}

/**
 * Read a picked archive without installing anything from it.
 *
 * Its own call so the file can be described before it is installed: a file name
 * is whatever the person who sent it typed, and the package inside is the thing
 * about to be added to a profile.
 */
export const pluginArchive = (path: string): Promise<ArchivePackage> =>
  invoke('plugin_archive', { path })

/** Install from an archive instead of the registry; answers with the profile. */
export const pluginImport = (path: string): Promise<PluginState> =>
  invoke('plugin_import', { path })

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

export interface ProfileStartupRecovery {
  generation: string
  failedProfile: string
  recoveredProfile: string | null
  reason: string
  /** Active third-party plugins in the failed profile that can be disabled safely. */
  plugins: string[]
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
  /** Canonical SHA-256 written by current exports. */
  integrity?: string
  /** True only after the native side recomputed and matched the digest. */
  verified: boolean
}

export const profileRoster = (): Promise<Roster> => invoke('profile_roster')

export const profileRecoveryNotice = (): Promise<ProfileStartupRecovery | null> =>
  invoke('profile_recovery_notice')

export const profileRecoveryAcknowledge = (): Promise<void> =>
  invoke('profile_recovery_acknowledge')

export const profileRecoveryDisablePlugin = (
  name: string,
  generation: string,
): Promise<ProfileStartupRecovery> =>
  invoke('profile_recovery_disable_plugin', { name, generation })

export const profileRecoveryRetry = (generation: string): Promise<Roster> =>
  invoke('profile_recovery_retry', { generation })

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

/**
 * The three shapes a conversation can leave in.
 *
 * Chosen by where it is going rather than by taste: Markdown for an issue or a
 * weekly note, HTML for a file somebody opens without any tooling at all, and
 * JSON for whatever reads it next.
 */
export type SessionFormat = 'markdown' | 'html' | 'json'

/** A rendered session, and what to call the file it should go in. */
export interface SessionExport {
  /** The name to offer, which the save dialog may well be told to override. */
  name: string
  text: string
}

/**
 * Render a session, without deciding yet where it goes.
 *
 * The text comes back rather than being written because there are two things to
 * do with it and only one of them is a file: pasting a conversation into an
 * issue is the other, and it is the more common one.
 */
export const sessionExport = (id: string, format: SessionFormat): Promise<SessionExport> =>
  invoke('session_export', { id, format })

/**
 * Put a rendered session where the save dialog pointed.
 *
 * Rust does the writing because this shell holds no filesystem permission at
 * all — the only path it can name is the one the system's own dialog returned.
 */
export const sessionSave = (path: string, text: string): Promise<void> =>
  invoke('session_save', { path, text })

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

/**
 * Open another window onto the same harness.
 *
 * Nothing is duplicated by this: one supervisor, one profile, one shelf of
 * sessions, and every window a view onto them. What the second window has of its
 * own is the conversation loaded in it, which is the reason to ask for one.
 *
 * Rust picks where it lands and what it is called, because both are answers
 * about the machine — which display the window that asked is on, and which
 * numbers are already taken.
 */
export const windowOpen = (): Promise<void> => invoke('window_open')

/* -------------------------------------------------------------------------- */
/* Between windows                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The things that are one thing on the machine and a copy in every window.
 *
 * `theme` is a line in storage, `profiles` is a set of directories on disk.
 * Nothing the supervisor owns belongs here — the harness, remote access and the
 * shells are already emitted from Rust to every window, and echoing one of them
 * would be a second source of truth for something that has one.
 */
export type Shared = 'theme' | 'profiles' | 'presentation'

/** Channel the windows use to poke each other. */
const SHARED_CHANNEL = 'shell://changed'

/**
 * Say that a shared thing has changed.
 *
 * The signal names a subject and never carries the new value, for the reason
 * `onRemoteChange` gives: a listener that reads the answer itself cannot apply
 * a stale one. It also comes back to the window that sent it, which is why
 * every listener has to be idempotent — being told twice must cost a reread
 * rather than a wrong screen.
 */
export const announce = (subject: Shared): Promise<void> => emit(SHARED_CHANNEL, subject)

export const onSharedChange = (handler: (subject: Shared) => void): Promise<UnlistenFn> =>
  listen<Shared>(SHARED_CHANNEL, (message) => handler(message.payload))

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

/** Internal generic attention emitted from the Harness's job event stream. */
export const desktopAttention = (kind: 'job-completed' | 'job-failed'): Promise<void> =>
  invoke('desktop_attention', { kind })

/** Put a count on the tray and the taskbar, or zero to take it off. */
export const desktopBadge = (count: number): Promise<void> => invoke('desktop_badge', { count })

export const onDesktopLink = (handler: (link: DesktopLink) => void): Promise<UnlistenFn> =>
  listen<DesktopLink>(LINK_CHANNEL, (message) => handler(message.payload))

/* -------------------------------------------------------------------------- */
/* Startup                                                                    */
/* -------------------------------------------------------------------------- */

/** How this machine reaches the app while its window is not in front. */
export interface Startup {
  /** Whether the operating system has a login item for this application. */
  autostart: boolean
  /** The accelerator the user chose, if any. */
  shortcut: string | null
  /**
   * Whether that accelerator is registered right now. False while one is set
   * means another program on this machine got to the combination first.
   */
  held: boolean
  /** What to offer when nothing is chosen yet. */
  suggested: string
  notifications: NotificationPreferences
  logLevel: LogLevel
  /** Fixed loopback port, or null for an OS-assigned collision-free port. */
  harnessPort: number | null
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface NotificationPreferences {
  turnCompleted: boolean
  turnFailed: boolean
  jobCompleted: boolean
  jobFailed: boolean
}

export type NotificationPreference =
  'turn-completed' | 'turn-failed' | 'job-completed' | 'job-failed'

export const startupState = (): Promise<Startup> => invoke('startup_state')

export const startupAutostart = (enabled: boolean): Promise<Startup> =>
  invoke('startup_autostart', { enabled })

/** `null` gives up the key. Anything else is registered before it is saved. */
export const startupShortcut = (accelerator: string | null): Promise<Startup> =>
  invoke('startup_shortcut', { accelerator })

export const startupNotification = (
  kind: NotificationPreference,
  enabled: boolean,
): Promise<Startup> => invoke('startup_notification', { kind, enabled })

/** Request native notification access and deliver one explicit test message. */
export const startupNotificationTest = (): Promise<Startup> => invoke('startup_notification_test')

export const startupLogLevel = (level: LogLevel): Promise<Startup> =>
  invoke('startup_log_level', { level })

export const startupHarnessPort = (port: number | null): Promise<Startup> =>
  invoke('startup_harness_port', { port })

/* -------------------------------------------------------------------------- */
/* About                                                                      */
/* -------------------------------------------------------------------------- */

export interface About {
  version: string
  platform: string
  arch: string
  edition: 'lite' | 'full'
  appData: string
  harnessDir: string
  profileDir: string
}

export const about = (): Promise<About> => invoke('app_about')

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/** A finished report, and what to call the file it should go in. */
export interface Report {
  /** The name to offer, which the save dialog may well be told to override. */
  name: string
  archiveName: string
  text: string
}

/**
 * Everything this shell knows about its own install, as one Markdown document.
 *
 * Markdown because of where it is going: an issue. The home directory is taken
 * out of it before it arrives here, so what comes back is already safe to paste
 * somewhere public — which is the only reason the copy button can be one click.
 */
export const reportBuild = (): Promise<Report> => invoke('report_build')

/** The same document, put where the save dialog pointed. */
export const reportSave = (path: string, text: string): Promise<void> =>
  invoke('report_save', { path, text })

/** A bounded ZIP with the redacted report, recent logs and local crash evidence. */
export const reportArchive = (path: string, text: string): Promise<void> =>
  invoke('report_archive', { path, text })

export const frontendCrash = (payload: {
  message: string
  stack: string
  url: string
}): Promise<void> => invoke('report_frontend_crash', payload)

/** Mark this window healthy only after React committed the application root. */
export const rendererReady = (): Promise<void> => invoke('renderer_ready')
const APPLICATION_CHECK_UPDATE = 'application://check-update'

/** The native macOS application menu asked for an interactive update check. */
export const onApplicationCheckUpdate = (handler: () => void): Promise<UnlistenFn> =>
  listen(APPLICATION_CHECK_UPDATE, handler)

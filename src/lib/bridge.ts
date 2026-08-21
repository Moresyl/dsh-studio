/**
 * The desktop, answered on behalf of whatever the harness is running.
 *
 * The harness UI is a frame inside this window, and a frame cannot reach Tauri:
 * capabilities are granted per webview, so opening the IPC to it would hand a
 * page every command this shell has — starting processes, removing profiles,
 * opening shells. That is not a trade worth making for four conveniences.
 *
 * So the frame gets a letterbox instead. It posts a request up, this module
 * decides whether to carry it out, and posts an answer back. Four methods, all
 * of them below, all of them readable in one sitting — which is the point.
 *
 * The trust boundary is drawn twice, because either check alone has a hole:
 *
 *   - the sender's origin has to be the origin the harness is serving on right
 *     now, which turns away a page the harness frames in from the internet;
 *   - and the sender has to be a frame of *this* window, which turns away
 *     anything that merely shares that origin — a popup, another tab.
 *
 * Nothing is served while nothing is serving, because there is no origin to
 * trust then. The client half of this lives in `src-tauri/src/desktop/client.js`.
 */
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'

import { describe } from '@/lib/errors'
import * as ipc from '@/lib/ipc'

/**
 * The version of the protocol spoken here.
 *
 * Written down twice — once here and once as `PROTOCOL` in
 * `src-tauri/src/desktop/mod.rs` — because the two halves have to be able to
 * refuse each other. `bridge.test.ts` reads the Rust file and fails if they
 * ever stop agreeing.
 */
export const PROTOCOL = 3

/** How far down the frame tree a pushed message is carried. */
const DEPTH = 8

/** The largest count Rust will take, since the badge crosses as a `u32`. */
const COUNT_CEILING = 0xffff_ffff

/**
 * The part of a window this module uses.
 *
 * Declared here rather than borrowed from the DOM's `Window` because that is
 * not what is being handled: `MessageEvent.source` is a union of three kinds of
 * sender, and "a frame of this window" is none of them. The identity check in
 * `ours` is what makes a sender one of these.
 */
interface Frame {
  readonly frames: ArrayLike<Frame | undefined>
  postMessage(message: unknown, targetOrigin: string): void
}

/** A request that passed the door and is worth reading. */
export interface Call {
  id: string
  method: string
  params: Record<string, unknown>
}

/**
 * Read an arriving message as a request, or refuse it by answering null.
 *
 * Separate from the listener so the door can be tested without a window: this
 * is the whole of what gets in, and none of it depends on a DOM.
 */
export function accepts(serving: string, from: string, data: unknown): Call | null {
  // A door onto nothing is a door that stays shut. There is no origin to trust
  // while the harness is not serving, and no request that could be from it.
  if (!serving || from !== serving) return null
  if (typeof data !== 'object' || data === null) return null

  const { dsh, id, method, params } = data as Record<string, unknown>
  // Also what keeps this shell's own replies and pushes from being read back as
  // requests: neither carries a method.
  if (dsh !== PROTOCOL) return null
  if (typeof id !== 'string' || !id) return null
  if (typeof method !== 'string') return null

  return {
    id,
    method,
    params:
      typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {},
  }
}

/**
 * Carry out a request, or throw the sentence explaining why not.
 *
 * Every argument is read defensively rather than trusted: what arrives is
 * whatever a page chose to post, and a frame that sends nonsense should get an
 * error back instead of a dialog with `undefined` in the title.
 */
export async function answer({ method, params }: Call): Promise<unknown> {
  switch (method) {
    case 'hello':
      return await ipc.desktopOffer()

    case 'notify': {
      const title = text(params.title).trim()
      // A notification is a whole system's attention. Without a title there is
      // nothing for it to be about, and a blank one reads as a broken app.
      if (!title) throw new Error('a notification needs a title')
      await ipc.desktopNotify(title, text(params.body).trim())
      return {}
    }

    case 'attention': {
      const kind = text(params.kind)
      if (kind !== 'job-completed' && kind !== 'job-failed') {
        throw new Error('the desktop attention kind is not supported')
      }
      await ipc.desktopAttention(kind)
      return {}
    }

    case 'pick':
      // Null and not an error: choosing nothing is an answer.
      return { path: await pick(params) }

    case 'workspace.validate': {
      const path = text(params.path).trim()
      if (!path) throw new Error('workspace validation needs a path')
      const admission = await ipc.workspaceInspect(path)
      return {
        allowed: admission.state !== 'blocked',
        reason: admission.reason,
      }
    }

    case 'badge':
      await ipc.desktopBadge(counted(params.count))
      return {}

    case 'profiles.list':
      return await ipc.profileRoster()

    case 'profiles.select': {
      const name = text(params.name).trim()
      if (!name) throw new Error('a profile selection needs a name')
      const roster = await ipc.profileSelect(name)
      await ipc.announce('profiles')
      return { roster, restartRequired: true }
    }

    case 'plugins.install': {
      const name = text(params.name).trim()
      const version = text(params.version).trim()
      if (!name || !version) throw new Error('a plugin install needs an exact name and version')
      const sources = await ipc.pluginSources()
      const source = sources.find((candidate) => candidate.active)
      if (!source) throw new Error('no plugin catalog source is active')
      const preview = await ipc.pluginPreview(
        `${name}@${version}`,
        source.id,
        name,
        text(params.displayName).trim() || name,
      )
      const profile = await ipc.pluginAdd(preview.token)
      await ipc.announce('profiles')
      return profile
    }

    case 'plugins.remove': {
      const name = text(params.name).trim()
      if (!name) throw new Error('a plugin removal needs a package name')
      const profile = await ipc.pluginRemove(name)
      await ipc.announce('profiles')
      return profile
    }

    default:
      throw new Error(`the desktop has no method named ${method}`)
  }
}

/**
 * Serve the desktop to the harness frame for as long as it is loaded.
 *
 * Called with the origin the harness is serving on, and taken down when that
 * changes — a restart on a new port is a new trust boundary, not the same one
 * moved.
 */
export async function serveDesktop(origin: string): Promise<() => void> {
  const onMessage = (event: MessageEvent) => {
    const call = accepts(origin, event.origin, event.data)
    if (!call) return

    const source = event.source
    if (!ours(source)) return

    void settle(source, origin, call)
  }

  window.addEventListener('message', onMessage)

  // Links arrive from the system at any moment, so they are pushed rather than
  // asked for. One that arrived before this frame existed is not pushed at all
  // — it is waiting in the handshake instead, which is the only way a link that
  // started the app reaches a page that took seconds to load.
  const unlisten = await ipc.onDesktopLink((link) => {
    tell({ dsh: PROTOCOL, event: 'link', link }, origin)
  })

  return () => {
    window.removeEventListener('message', onMessage)
    unlisten()
  }
}

/** Hand one native folder drop to the visible Harness UI, and nowhere else. */
export function pushWorkspaceDrop(path: string, origin: string): void {
  const selected = path.trim()
  if (!selected || !origin) return
  tell({ dsh: PROTOCOL, event: 'workspace-drop', path: selected }, origin)
}

/** Answer one request, whichever way it went. */
async function settle(source: Frame, origin: string, call: Call): Promise<void> {
  try {
    const value = await answer(call)
    source.postMessage({ dsh: PROTOCOL, id: call.id, ok: true, value }, origin)
  } catch (cause) {
    // The sentence, not the stack: this is read by a plugin author in a console
    // and by a user in whatever the plugin does with it.
    source.postMessage({ dsh: PROTOCOL, id: call.id, ok: false, error: describe(cause) }, origin)
  }
}

/**
 * Push a message to every frame under this window that is allowed to hear it.
 *
 * The origin is passed as the target rather than checked here, so the browser
 * is the one enforcing it: a frame showing something else is handed nothing,
 * without this code having to be able to see what it is showing.
 */
function tell(message: unknown, origin: string): void {
  for (const frame of descendants(window)) frame.postMessage(message, origin)
}

/** Whether a sender is one of this window's own frames. */
function ours(source: unknown): source is Frame {
  for (const frame of descendants(window)) {
    if (frame === source) return true
  }
  return false
}

/**
 * Every frame below `root`, the harness's own and whatever it frames in turn.
 *
 * Depth-limited rather than trusted to end: the tree is walked on every message
 * from a page this shell does not control, and a page that nests itself is a
 * page that would otherwise nest this loop.
 */
function* descendants(root: Frame, depth = 0): Generator<Frame> {
  if (depth >= DEPTH) return

  const { frames } = root
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    if (!frame) continue
    yield frame
    yield* descendants(frame, depth + 1)
  }
}

/**
 * Ask the system for a path.
 *
 * The dialog is opened by the shell and not by Rust, because the shell already
 * holds the permission for it — and because a modal that belongs to the window
 * is one the window can be sure only opens over itself.
 */
async function pick(params: Record<string, unknown>): Promise<string | null> {
  const mode = params.mode === undefined ? 'open' : params.mode
  const title = text(params.title) || undefined
  const defaultPath = text(params.defaultPath) || undefined

  switch (mode) {
    case 'open': {
      const chosen = await openDialog({
        title,
        defaultPath,
        filters: filters(params.filters),
        multiple: false,
        directory: false,
      })
      return typeof chosen === 'string' ? chosen : null
    }

    case 'directory': {
      const chosen = await openDialog({ title, defaultPath, multiple: false, directory: true })
      return typeof chosen === 'string' ? chosen : null
    }

    case 'save':
      return await saveDialog({ title, defaultPath, filters: filters(params.filters) })

    default:
      throw new Error(`no such way to pick a path: ${String(mode)}`)
  }
}

/** File types a picker offers, with anything unreadable dropped rather than shown. */
function filters(value: unknown): { name: string; extensions: string[] }[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return []

    const { name, extensions } = entry as Record<string, unknown>
    if (!Array.isArray(extensions)) return []

    // A leading dot is how half the world writes an extension and is not what
    // the dialog wants, so it is taken off rather than refused.
    const kept = extensions
      .filter((extension: unknown): extension is string => typeof extension === 'string')
      .map((extension) => extension.replace(/^\./, ''))
      .filter(Boolean)
    if (!kept.length) return []

    return [{ name: text(name) || kept.join(', '), extensions: kept }]
  })
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A badge is a count of things, so it is a whole number and there is no −1 of it. */
function counted(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('a badge needs a count of zero or more')
  }
  return Math.min(Math.floor(value), COUNT_CEILING)
}

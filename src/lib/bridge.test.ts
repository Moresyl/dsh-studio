import { readFileSync } from 'node:fs'

import { afterEach, beforeEach, describe as group, expect, it, vi } from 'vitest'

// Hoisted with the `vi.mock` call that hands them over, because `bridge.ts`
// reaches for the dialog on the way in rather than at the moment it is opened.
const { openDialog, saveDialog } = vi.hoisted(() => ({
  openDialog: vi.fn(),
  saveDialog: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openDialog, save: saveDialog }))
vi.mock('@/lib/ipc', () => ({
  desktopOffer: vi.fn(),
  desktopNotify: vi.fn(),
  desktopAttention: vi.fn(),
  desktopBadge: vi.fn(),
  profileRoster: vi.fn(),
  profileSelect: vi.fn(),
  pluginSources: vi.fn(),
  pluginPreview: vi.fn(),
  pluginAdd: vi.fn(),
  pluginRemove: vi.fn(),
  workspaceInspect: vi.fn(),
  announce: vi.fn(),
  onDesktopLink: vi.fn(),
}))

import {
  accepts,
  answer,
  PROTOCOL,
  pushWorkspaceDrop,
  serveDesktop,
  type Call,
} from '@/lib/bridge'
import * as ipc from '@/lib/ipc'

const SERVING = 'http://127.0.0.1:57652'

const request = (method: string, params: Record<string, unknown> = {}): Call => ({
  id: 'dsh-1',
  method,
  params,
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

group('accepts', () => {
  const message = { dsh: PROTOCOL, id: 'dsh-1', method: 'hello', params: { a: 1 } }

  it('reads a request from the origin the harness is serving on', () => {
    expect(accepts(SERVING, SERVING, message)).toEqual({
      id: 'dsh-1',
      method: 'hello',
      params: { a: 1 },
    })
  })

  // The whole security boundary: a page the harness frames in from the internet
  // runs in this window too, and this is what tells the two apart.
  it('refuses a request from anywhere but that origin', () => {
    expect(accepts(SERVING, 'https://plugin.example.com', message)).toBeNull()
    expect(accepts(SERVING, 'http://127.0.0.1:57653', message)).toBeNull()
    expect(accepts(SERVING, 'null', message)).toBeNull()
  })

  // There is no origin to trust while nothing is serving, so nothing is.
  it('refuses everything while the harness is not serving', () => {
    expect(accepts('', '', message)).toBeNull()
  })

  it('ignores messages that are not this protocol', () => {
    expect(accepts(SERVING, SERVING, { ...message, dsh: 99 })).toBeNull()
    expect(accepts(SERVING, SERVING, { id: 'x', method: 'hello' })).toBeNull()
    expect(accepts(SERVING, SERVING, 'webpackHotUpdate')).toBeNull()
    expect(accepts(SERVING, SERVING, null)).toBeNull()
  })

  // Both halves of the conversation travel over the same channel, and a shell
  // that read its own answers back as questions would answer them forever.
  it('does not read a reply or a pushed link as a request', () => {
    expect(
      accepts(SERVING, SERVING, { dsh: PROTOCOL, id: 'dsh-1', ok: true, value: {} }),
    ).toBeNull()
    expect(accepts(SERVING, SERVING, { dsh: PROTOCOL, event: 'link', link: {} })).toBeNull()
  })

  it('stands in an empty bag of arguments for a missing one', () => {
    expect(accepts(SERVING, SERVING, { dsh: PROTOCOL, id: 'a', method: 'hello' })?.params).toEqual(
      {},
    )
    expect(
      accepts(SERVING, SERVING, { dsh: PROTOCOL, id: 'a', method: 'hello', params: 7 })?.params,
    ).toEqual({})
  })
})

group('answer', () => {
  it('hands the handshake back as the desktop described it', async () => {
    const offer = { protocol: PROTOCOL, app: 'DSH Studio', capabilities: ['notify'], link: null }
    vi.mocked(ipc.desktopOffer).mockResolvedValue(offer as never)

    await expect(answer(request('hello'))).resolves.toBe(offer)
  })

  it('refuses a method it does not have, by name', async () => {
    await expect(answer(request('exec'))).rejects.toThrow('exec')
  })

  group('notify', () => {
    it('passes a title and body through', async () => {
      await answer(request('notify', { title: '  Done  ', body: ' 3 files ' }))

      expect(ipc.desktopNotify).toHaveBeenCalledWith('Done', '3 files')
    })

    it('sends a bodiless notification rather than inventing text for it', async () => {
      await answer(request('notify', { title: 'Done' }))

      expect(ipc.desktopNotify).toHaveBeenCalledWith('Done', '')
    })

    // A notification with nothing in the title is a system-wide blank rectangle.
    it('refuses one with nothing to say', async () => {
      await expect(answer(request('notify', { body: 'only a body' }))).rejects.toThrow()
      await expect(answer(request('notify', { title: '   ' }))).rejects.toThrow()
      await expect(answer(request('notify', { title: 42 }))).rejects.toThrow()
      expect(ipc.desktopNotify).not.toHaveBeenCalled()
    })
  })

  group('public profile and plugin services', () => {
    it('lists profiles and marks a selected profile as restart-bound', async () => {
      vi.mocked(ipc.profileRoster).mockResolvedValue({ selected: 'web' } as never)
      vi.mocked(ipc.profileSelect).mockResolvedValue({ selected: 'lab' } as never)

      await expect(answer(request('profiles.list'))).resolves.toMatchObject({ selected: 'web' })
      await expect(answer(request('profiles.select', { name: 'lab' }))).resolves.toMatchObject({
        restartRequired: true,
        roster: { selected: 'lab' },
      })
      expect(ipc.announce).toHaveBeenCalledWith('profiles')
    })

    it('installs an exact item through the active catalog and removes it through Desktop', async () => {
      vi.mocked(ipc.pluginSources).mockResolvedValue([
        { id: 'npm', active: true, label: 'npm registry' },
      ] as never)
      vi.mocked(ipc.pluginAdd).mockResolvedValue({ profile: 'web' } as never)
      vi.mocked(ipc.pluginPreview).mockResolvedValue({ token: 'reviewed-once' } as never)
      vi.mocked(ipc.pluginRemove).mockResolvedValue({ profile: 'web' } as never)

      await answer(
        request('plugins.install', { name: '@vendor/tool', version: '1.2.3', displayName: 'Tool' }),
      )
      expect(ipc.pluginPreview).toHaveBeenCalledWith(
        '@vendor/tool@1.2.3',
        'npm',
        '@vendor/tool',
        'Tool',
      )
      expect(ipc.pluginAdd).toHaveBeenCalledWith('reviewed-once')
      await answer(request('plugins.remove', { name: '@vendor/tool' }))
      expect(ipc.pluginRemove).toHaveBeenCalledWith('@vendor/tool')
    })
  })

  group('workspace admission', () => {
    it('returns the backend decision without persisting the candidate', async () => {
      vi.mocked(ipc.workspaceInspect).mockResolvedValue({
        state: 'blocked',
        filesystem: 'exFAT',
        reason: 'unsafe filesystem',
      })

      await expect(answer(request('workspace.validate', { path: ' E:\\repo ' }))).resolves.toEqual({
        allowed: false,
        reason: 'unsafe filesystem',
      })
      expect(ipc.workspaceInspect).toHaveBeenCalledWith('E:\\repo')
    })

    it('rejects an empty candidate before crossing the native boundary', async () => {
      await expect(answer(request('workspace.validate', { path: '   ' }))).rejects.toThrow()
      expect(ipc.workspaceInspect).not.toHaveBeenCalled()
    })
  })

  group('background attention', () => {
    it('accepts only the two privacy-safe job outcomes', async () => {
      await answer(request('attention', { kind: 'job-completed' }))
      await answer(request('attention', { kind: 'job-failed' }))
      expect(ipc.desktopAttention).toHaveBeenNthCalledWith(1, 'job-completed')
      expect(ipc.desktopAttention).toHaveBeenNthCalledWith(2, 'job-failed')

      await expect(answer(request('attention', { kind: 'running' }))).rejects.toThrow()
      expect(ipc.desktopAttention).toHaveBeenCalledTimes(2)
    })
  })

  group('badge', () => {
    it('counts whole things', async () => {
      await answer(request('badge', { count: 3.7 }))

      expect(ipc.desktopBadge).toHaveBeenCalledWith(3)
    })

    it('takes zero as the way to clear it', async () => {
      await answer(request('badge', { count: 0 }))

      expect(ipc.desktopBadge).toHaveBeenCalledWith(0)
    })

    // The count crosses to Rust as a `u32`, and a number that cannot be one
    // would be refused there as a malformed command rather than as a big number.
    it('never asks Rust to hold a count it has no room for', async () => {
      await answer(request('badge', { count: 1e30 }))

      expect(ipc.desktopBadge).toHaveBeenCalledWith(0xffff_ffff)
    })

    it('refuses anything that is not a count', async () => {
      for (const count of [-1, Number.NaN, Infinity, '4', null, undefined]) {
        await expect(answer(request('badge', { count }))).rejects.toThrow()
      }
      expect(ipc.desktopBadge).not.toHaveBeenCalled()
    })
  })

  group('pick', () => {
    it('opens a file picker by default', async () => {
      openDialog.mockResolvedValue('D:\\notes.md')

      await expect(answer(request('pick'))).resolves.toEqual({ path: 'D:\\notes.md' })
      expect(openDialog).toHaveBeenCalledWith(
        expect.objectContaining({ directory: false, multiple: false }),
      )
    })

    // Dismissing a dialog is a decision, not a failure — a plugin that treated
    // it as one would show an error for someone changing their mind.
    it('answers with no path when the dialog was dismissed', async () => {
      openDialog.mockResolvedValue(null)

      await expect(answer(request('pick'))).resolves.toEqual({ path: null })
    })

    it('asks for a directory and for a save path in their own dialogs', async () => {
      openDialog.mockResolvedValue('D:\\work')
      await expect(answer(request('pick', { mode: 'directory' }))).resolves.toEqual({
        path: 'D:\\work',
      })
      expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }))

      saveDialog.mockResolvedValue('D:\\out.json')
      await expect(answer(request('pick', { mode: 'save' }))).resolves.toEqual({
        path: 'D:\\out.json',
      })
    })

    it('refuses a way of picking that does not exist', async () => {
      await expect(answer(request('pick', { mode: 'delete' }))).rejects.toThrow('delete')
      expect(openDialog).not.toHaveBeenCalled()
    })

    it('cleans up file types and drops the ones it cannot read', async () => {
      openDialog.mockResolvedValue(null)

      await answer(
        request('pick', {
          filters: [
            { name: 'Notes', extensions: ['.md', 'txt', 7] },
            { name: 'Broken', extensions: 'md' },
            'nonsense',
            { extensions: ['json'] },
          ],
        }),
      )

      expect(openDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [
            { name: 'Notes', extensions: ['md', 'txt'] },
            { name: 'json', extensions: ['json'] },
          ],
        }),
      )
    })

    it('leaves the dialog to name itself when nothing readable was given', async () => {
      openDialog.mockResolvedValue(null)

      await answer(request('pick', { title: 12, defaultPath: null }))

      expect(openDialog).toHaveBeenCalledWith(
        expect.objectContaining({ title: undefined, defaultPath: undefined }),
      )
    })
  })
})

group('desktop frame lifetime', () => {
  function windowTree() {
    const posted = vi.fn()
    const child = { frames: [], postMessage: posted }
    let message: ((event: MessageEvent) => void) | undefined
    const root = {
      frames: [child],
      postMessage: vi.fn(),
      addEventListener: vi.fn((name: string, listener: (event: MessageEvent) => void) => {
        if (name === 'message') message = listener
      }),
      removeEventListener: vi.fn(),
    }
    vi.stubGlobal('window', root)
    return { root, child, posted, message: () => message }
  }

  it('answers only its own harness frame and tears every listener down', async () => {
    const tree = windowTree()
    const unlisten = vi.fn()
    let link: Parameters<typeof ipc.onDesktopLink>[0] | undefined
    vi.mocked(ipc.onDesktopLink).mockImplementation(async (listener) => {
      link = listener
      return unlisten
    })
    vi.mocked(ipc.desktopOffer).mockResolvedValue({ protocol: PROTOCOL } as never)

    const stop = await serveDesktop(SERVING)
    const listener = tree.message()
    expect(listener).toBeTypeOf('function')

    listener?.({
      origin: SERVING,
      source: tree.child,
      data: { dsh: PROTOCOL, id: 'trusted', method: 'hello' },
    } as unknown as MessageEvent)
    await vi.waitFor(() => expect(tree.posted).toHaveBeenCalledOnce())
    expect(tree.posted).toHaveBeenLastCalledWith(
      { dsh: PROTOCOL, id: 'trusted', ok: true, value: { protocol: PROTOCOL } },
      SERVING,
    )

    listener?.({
      origin: SERVING,
      source: tree.child,
      data: { dsh: PROTOCOL, id: 'unsupported', method: 'exec' },
    } as unknown as MessageEvent)
    await vi.waitFor(() => expect(tree.posted).toHaveBeenCalledTimes(2))
    expect(tree.posted).toHaveBeenLastCalledWith(
      {
        dsh: PROTOCOL,
        id: 'unsupported',
        ok: false,
        error: 'the desktop has no method named exec',
      },
      SERVING,
    )

    listener?.({
      origin: SERVING,
      source: { frames: [], postMessage: vi.fn() },
      data: { dsh: PROTOCOL, id: 'forged', method: 'hello' },
    } as unknown as MessageEvent)
    await Promise.resolve()
    expect(tree.posted).toHaveBeenCalledTimes(2)

    const opened = { url: 'dsh://open', route: 'open', query: {} }
    link?.(opened)
    expect(tree.posted).toHaveBeenLastCalledWith(
      { dsh: PROTOCOL, event: 'link', link: opened },
      SERVING,
    )

    stop()
    expect(tree.root.removeEventListener).toHaveBeenCalledWith('message', listener)
    expect(unlisten).toHaveBeenCalledOnce()
  })

  it('pushes a trimmed native workspace only while an origin is trusted', () => {
    const tree = windowTree()

    pushWorkspaceDrop('  D:\\repo  ', SERVING)
    pushWorkspaceDrop('   ', SERVING)
    pushWorkspaceDrop('D:\\other', '')

    expect(tree.posted).toHaveBeenCalledOnce()
    expect(tree.posted).toHaveBeenCalledWith(
      { dsh: PROTOCOL, event: 'workspace-drop', path: 'D:\\repo' },
      SERVING,
    )
  })
})

/* -------------------------------------------------------------------------- */
/* The injected client                                                        */
/* -------------------------------------------------------------------------- */

const SOURCE = readFileSync('src-tauri/src/desktop/client.js', 'utf8')

interface Posted {
  dsh?: number
  id?: string
  method?: string
  params?: Record<string, unknown>
}

interface Client {
  protocol: number
  hello(): Promise<unknown>
  notify(options: unknown): Promise<unknown>
  pick(options: unknown): Promise<unknown>
  badge(count: number): Promise<unknown>
  onLink(handler: (link: unknown) => void): () => void
  profiles: {
    list(): Promise<unknown>
    select(name: string): Promise<unknown>
  }
  plugins: {
    install(request: unknown): Promise<unknown>
    remove(name: string): Promise<unknown>
  }
  workspace: {
    validate(path: string): Promise<unknown>
    onDrop(handler: (path: string) => void): () => void
  }
}

/**
 * Run the real client script against a window that is not one.
 *
 * The script ships as a file rather than as a Rust string so it can be read and
 * edited as the program it is — and so this can execute the same text the app
 * injects, rather than a copy of it that drifts.
 */
function load({ observeJobs = false } = {}) {
  const sent: Posted[] = []
  const listeners: ((event: { data: unknown; source: unknown }) => void)[] = []
  const top = { postMessage: (data: Posted) => void sent.push(data) }
  const sockets: JobSocket[] = []

  class JobSocket {
    onmessage: ((message: { data: string }) => void) | null = null
    onclose: (() => void) | null = null

    constructor(readonly url: string) {
      sockets.push(this)
    }

    push(payload: unknown) {
      this.onmessage?.({ data: JSON.stringify({ payload }) })
    }
  }

  const frame = {
    top,
    ...(observeJobs
      ? {
          parent: top,
          location: { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:57652' },
          WebSocket: JobSocket,
          setTimeout: vi.fn(),
        }
      : {}),
    addEventListener: (
      name: string,
      handler: (event: { data: unknown; source: unknown }) => void,
    ) => void (name === 'message' && listeners.push(handler)),
    dshStudio: undefined as Client | undefined,
  }

  new Function('window', SOURCE.replace('__DSH_PROTOCOL__', String(PROTOCOL)))(frame)

  return {
    sent,
    sockets,
    client: () => {
      const client = frame.dshStudio
      if (!client) throw new Error('the client script installed nothing')
      return client
    },
    /** Deliver a message as the window above would. */
    deliver: (data: unknown, source: unknown = top) => {
      for (const listener of listeners) listener({ data, source })
    },
  }
}

group('the injected client', () => {
  it('is the whole of feature detection: present, frozen, and named', () => {
    const client = load().client()

    expect(client.protocol).toBe(PROTOCOL)
    expect(Object.isFrozen(client)).toBe(true)
    expect(Object.keys(client).sort()).toEqual([
      'badge',
      'hello',
      'notify',
      'onLink',
      'pick',
      'plugins',
      'profiles',
      'protocol',
      'workspace',
    ])
    expect(Object.isFrozen(client.profiles)).toBe(true)
    expect(Object.isFrozen(client.plugins)).toBe(true)
    expect(Object.isFrozen(client.workspace)).toBe(true)
  })

  it('validates and publishes native workspace drops through the narrow seam', async () => {
    const desk = load()
    const dropped = vi.fn()
    const dispose = desk.client().workspace.onDrop(dropped)
    const validation = desk.client().workspace.validate('D:\\repo')

    expect(desk.sent).toEqual([
      {
        dsh: PROTOCOL,
        id: 'dsh-1',
        method: 'workspace.validate',
        params: { path: 'D:\\repo' },
      },
    ])
    desk.deliver({ dsh: PROTOCOL, event: 'workspace-drop', path: 'D:\\repo' })
    expect(dropped).toHaveBeenCalledWith('D:\\repo')
    dispose()
    desk.deliver({ dsh: PROTOCOL, event: 'workspace-drop', path: 'D:\\other' })
    expect(dropped).toHaveBeenCalledTimes(1)

    desk.deliver({ dsh: PROTOCOL, id: 'dsh-1', ok: true, value: { allowed: true } })
    await expect(validation).resolves.toEqual({ allowed: true })
  })

  it('stays out of the way in the window that has no window above it', () => {
    const alone = { top: {}, addEventListener: () => {}, dshStudio: undefined }
    alone.top = alone

    new Function('window', SOURCE.replace('__DSH_PROTOCOL__', String(PROTOCOL)))(alone)

    expect(alone.dshStudio).toBeUndefined()
  })

  it('sends a call up and settles it on the answer', async () => {
    const desk = load()
    const pending = desk.client().notify({ title: 'Done' })

    expect(desk.sent).toEqual([
      { dsh: PROTOCOL, id: 'dsh-1', method: 'notify', params: { title: 'Done' } },
    ])

    desk.deliver({ dsh: PROTOCOL, id: 'dsh-1', ok: true, value: {} })
    await expect(pending).resolves.toEqual({})
  })

  it('observes background job transitions once from the direct Harness frame', () => {
    const desk = load({ observeJobs: true })
    expect(desk.sockets[0]?.url).toBe('ws://127.0.0.1:57652/api/events.mux')

    desk.sockets[0]?.push({
      type: 'session/jobs',
      sessionId: 'one',
      jobs: [{ id: 'bash-1', status: 'running' }],
    })
    desk.sockets[0]?.push({
      type: 'session/jobs',
      sessionId: 'one',
      jobs: [{ id: 'bash-1', status: 'completed' }],
    })

    expect(desk.sent).toEqual([
      {
        dsh: PROTOCOL,
        id: 'dsh-1',
        method: 'attention',
        params: { kind: 'job-completed' },
      },
    ])
  })

  it('gives every call in flight its own name', async () => {
    const desk = load()
    const first = desk.client().badge(1)
    const second = desk.client().badge(2)

    desk.deliver({ dsh: PROTOCOL, id: 'dsh-2', ok: true, value: 'second' })
    await expect(second).resolves.toBe('second')

    desk.deliver({ dsh: PROTOCOL, id: 'dsh-1', ok: true, value: 'first' })
    await expect(first).resolves.toBe('first')
  })

  it('turns a refusal into a rejection carrying the reason', async () => {
    const desk = load()
    const pending = desk.client().badge(-1)

    desk.deliver({ dsh: PROTOCOL, id: 'dsh-1', ok: false, error: 'a badge needs a count' })
    await expect(pending).rejects.toThrow('a badge needs a count')
  })

  // A page that frames the harness could otherwise answer on the desktop's
  // behalf, and a plugin would have no way to tell the difference.
  it('hears nothing from anywhere but the window above it', async () => {
    const desk = load()
    const pending = desk.client().hello()
    let settled = false
    void pending.then(() => (settled = true))

    desk.deliver({ dsh: PROTOCOL, id: 'dsh-1', ok: true, value: 'forged' }, { other: true })
    desk.deliver({ dsh: 99, id: 'dsh-1', ok: true, value: 'wrong protocol' })
    await Promise.resolve()

    expect(settled).toBe(false)

    desk.deliver({ dsh: PROTOCOL, id: 'dsh-1', ok: true, value: 'real' })
    await expect(pending).resolves.toBe('real')
  })

  it('fans links out to every handler until each one steps away', () => {
    const desk = load()
    const first = vi.fn()
    const second = vi.fn()

    const stop = desk.client().onLink(first)
    desk.client().onLink(second)
    desk.deliver({ dsh: PROTOCOL, event: 'link', link: { route: 'open' } })

    expect(first).toHaveBeenCalledWith({ route: 'open' })
    expect(second).toHaveBeenCalledWith({ route: 'open' })

    stop()
    desk.deliver({ dsh: PROTOCOL, event: 'link', link: { route: 'again' } })

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledTimes(2)
  })

  // Two files, one number. They have to be able to refuse each other.
  it('speaks the version the Rust half was compiled with', () => {
    const rust = readFileSync('src-tauri/src/desktop/mod.rs', 'utf8')
    const declared = /const PROTOCOL: u32 = (\d+);/.exec(rust)?.[1]

    expect(declared).toBe(String(PROTOCOL))
  })
})

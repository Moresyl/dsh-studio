/**
 * The desktop, as seen from a page inside the harness.
 *
 * Injected into every frame this window loads, before that frame's own scripts
 * run, so a plugin finds `window.dshStudio` already there and never has to
 * install anything to look for it. Absent means a browser rather than the
 * studio, which is the whole of feature detection:
 *
 *     if (window.dshStudio) await window.dshStudio.notify({ title: 'Done' })
 *
 * Nothing here reaches the shell's own command surface. Every call is a message
 * to the window above, which answers it or refuses it — see `src/lib/bridge.ts`
 * for what is allowed and `src-tauri/src/desktop/mod.rs` for why it is so little.
 */
;(() => {
  // The shell's own document is a frame too, and it does not need a client to
  // talk to itself.
  if (window.top === window) return

  const PROTOCOL = __DSH_PROTOCOL__

  // A person can leave a file dialog open over lunch. Everything else either
  // answers immediately or is not going to.
  const PATIENT = new Set(['pick'])
  const DEADLINE = 20000

  /** Calls waiting for an answer, by the id they were sent under. */
  const waiting = new Map()
  const listeners = new Set()
  const workspaceDropListeners = new Set()
  let sent = 0

  window.addEventListener('message', (event) => {
    // The window above is the only thing that speaks this protocol, and a page
    // that frames this one cannot become it.
    if (event.source !== window.top) return

    const message = event.data
    if (!message || message.dsh !== PROTOCOL) return

    if (message.event === 'link') {
      for (const listener of listeners) listener(message.link)
      return
    }

    if (message.event === 'workspace-drop' && typeof message.path === 'string') {
      for (const listener of workspaceDropListeners) listener(message.path)
      return
    }

    const pending = waiting.get(message.id)
    if (!pending) return
    waiting.delete(message.id)
    clearTimeout(pending.timer)

    if (message.ok) pending.resolve(message.value)
    else pending.reject(new Error(message.error || 'the desktop refused the request'))
  })

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `dsh-${++sent}`
      const timer = PATIENT.has(method)
        ? 0
        : setTimeout(() => {
            waiting.delete(id)
            reject(new Error(`the desktop did not answer ${method}`))
          }, DEADLINE)

      waiting.set(id, { resolve, reject, timer })
      // The window above is this app's own, and it is the only recipient a
      // message to `window.top` can have.
      window.top.postMessage({ dsh: PROTOCOL, id, method, params: params || {} }, '*')
    })

  const pickDirectory = async () => (await call('pick', { mode: 'directory' })).path
  const validateDirectory = async (path) => (await call('workspace.validate', { path })).allowed

  // Compatibility globals consumed by the patched upstream browse flow. They
  // are intentionally two narrow functions rather than the Tauri command API.
  window.__DSH_DESKTOP_PICK_DIRECTORY__ = pickDirectory
  window.__DSH_DESKTOP_VALIDATE_DIRECTORY__ = validateDirectory

  window.dshStudio = Object.freeze({
    protocol: PROTOCOL,

    /** What this desktop is, what it grants, and any link that was waiting. */
    hello: () => call('hello'),

    /** Say something the window does not have to be open to hear. */
    notify: (options) => call('notify', options),

    /**
     * Ask for a path the way the system asks: `open`, `save` or `directory`.
     *
     * Resolves with `{ path: null }` when the dialog was dismissed, because
     * choosing nothing is an answer and not a failure.
     */
    pick: (options) => call('pick', options),

    /** Put a count on the tray and the taskbar, or zero to take it off. */
    badge: (count) => call('badge', { count }),

    /** Profile discovery and selection. Selection takes effect after restart. */
    profiles: Object.freeze({
      list: () => call('profiles.list'),
      select: (name) => call('profiles.select', { name }),
    }),

    /** Recoverable, exact-version plugin changes through the Desktop package gate. */
    plugins: Object.freeze({
      install: (request) => call('plugins.install', request),
      remove: (name) => call('plugins.remove', { name }),
    }),

    /** Native workspace admission and folder drops for the upstream UI. */
    workspace: Object.freeze({
      validate: (path) => call('workspace.validate', { path }),
      onDrop: (handler) => {
        workspaceDropListeners.add(handler)
        return () => workspaceDropListeners.delete(handler)
      },
    }),

    /** Hear `dsh://` links as they arrive. Returns the way to stop hearing them. */
    onLink: (handler) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  })

  // Only the Harness frame directly below the native shell owns this stream.
  // Nested plugin frames get the public desktop API but must not each create a
  // duplicate job observer. The event endpoint is same-origin and downlink-only.
  if (
    window.parent === window.top &&
    window.location &&
    (window.location.hostname === '127.0.0.1' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '::1') &&
    typeof window.WebSocket === 'function'
  ) {
    const jobs = new Map()
    let stopped = false

    const watchJobs = () => {
      if (stopped) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new window.WebSocket(`${protocol}//${window.location.host}/api/events.mux`)

      socket.onmessage = (message) => {
        try {
          const frame = JSON.parse(message.data).payload
          if (!frame || frame.type !== 'session/jobs' || !Array.isArray(frame.jobs)) return
          for (const job of frame.jobs) {
            if (!job || typeof job.id !== 'string' || typeof job.status !== 'string') continue
            const key = `${frame.sessionId}:${job.id}`
            const previous = jobs.get(key)
            jobs.set(key, job.status)
            if (previous !== 'running' && previous !== 'stopping') continue
            if (job.status === 'completed')
              void call('attention', { kind: 'job-completed' }).catch(() => {})
            if (job.status === 'failed')
              void call('attention', { kind: 'job-failed' }).catch(() => {})
          }
        } catch {
          // A malformed push belongs to the transport, not to the native shell.
        }
      }
      socket.onclose = () => {
        if (!stopped) window.setTimeout(watchJobs, 2000)
      }
    }

    window.addEventListener('beforeunload', () => {
      stopped = true
    })
    watchJobs()
  }
})()

window.__ModuleLoader__.load({
  id: '@moresyl/dsh-studio-integration',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // uiWorkspace exists from Harness 0.1.2; inject stays tolerant so either
    // generation loads (a missing service is skipped by the loader).
    const inject = ['workspaces', 'uiWorkspace']

    const themeStyle = `
      body[data-dsh-studio-theme] {
        font-family: 'OpenAI Sans', -apple-system-body, ui-sans-serif, -apple-system,
          BlinkMacSystemFont, 'Segoe UI', Helvetica, 'PingFang SC', 'Microsoft YaHei UI', Arial,
          sans-serif !important;
        font-feature-settings: normal !important;
      }
      body[data-dsh-studio-theme] button,
      body[data-dsh-studio-theme] input,
      body[data-dsh-studio-theme] textarea {
        font-family: inherit;
      }
      body[data-dsh-studio-theme='dark'] {
        --dsw-alias-bg-base: #212121 !important;
        --dsw-alias-bg-layer-1: #181818 !important;
        --dsw-alias-bg-layer-2: #282828 !important;
        --dsw-alias-bg-layer-3: #303030 !important;
        --dsw-alias-bg-overlay: #212121 !important;
        --dsw-alias-border-l1: #ffffff1a !important;
        --dsw-alias-border-l2: #ffffff1f !important;
        --dsw-alias-border-l3: #ffffff33 !important;
        --dsw-alias-label-primary: #ededed !important;
        --dsw-alias-label-secondary: #afafaf !important;
        --dsw-alias-label-tertiary: #999999 !important;
        --dsw-alias-brand-primary: #ededed !important;
        --dsw-alias-brand-text: #ededed !important;
        --dsw-alias-button-primary-fill: #ededed !important;
        --dsw-alias-button-primary-hover: #ffffff !important;
        --dsw-alias-interactive-bg-hover: #303030 !important;
        --dsw-alias-interactive-bg-active: #393939 !important;
      }
      body[data-dsh-studio-theme='light'] {
        --dsw-alias-bg-base: #ffffff !important;
        --dsw-alias-bg-layer-1: #f9f9f9 !important;
        --dsw-alias-bg-layer-2: #f3f3f3 !important;
        --dsw-alias-bg-layer-3: #ededed !important;
        --dsw-alias-bg-overlay: #ffffff !important;
        --dsw-alias-border-l1: #00000014 !important;
        --dsw-alias-border-l2: #0000001f !important;
        --dsw-alias-border-l3: #00000033 !important;
        --dsw-alias-label-primary: #282828 !important;
        --dsw-alias-label-secondary: #5d5d5d !important;
        --dsw-alias-label-tertiary: #6b6b6b !important;
        --dsw-alias-brand-primary: #0d0d0d !important;
        --dsw-alias-brand-text: #0d0d0d !important;
        --dsw-alias-button-primary-fill: #0d0d0d !important;
        --dsw-alias-button-primary-hover: #303030 !important;
        --dsw-alias-interactive-bg-hover: #ededed !important;
        --dsw-alias-interactive-bg-active: #dfdfdf !important;
      }
    `

    function apply(ctx) {
      const desktop = window.dshStudio
      if (!desktop || !desktop.workspace || typeof desktop.workspace.onDrop !== 'function') return

      if (window.parent !== window) {
        let active = true
        let reading = 0
        const fileReads = new Map()
        let readImage = null
        // Keep theme/workspace integration active on generations without this API.
        ctx.inject(['remote', 'remote.session'], (client) => {
          readImage = (request) => client.remote.session.attachment(request)
          client.effect(
            () => () => {
              readImage = null
            },
            'dsh-studio: image API lifetime',
          )
        })
        const onImage = async (event) => {
          const request = event.data
          if (event.source === window.parent && request?.type === 'dsh-studio:preview-cancel') {
            fileReads.get(request.id)?.abort()
            return
          }
          if (event.source !== window.parent || request?.type !== 'dsh-studio:image-read') return
          if (request.kind !== undefined && !['image', 'file', 'download'].includes(request.kind)) return
          if (
            typeof request.id !== 'string' ||
            request.id.length > 64 ||
            typeof request.sessionId !== 'string' ||
            !request.sessionId ||
            request.sessionId.length > 512 ||
            typeof request.attachmentId !== 'string' ||
            !/^sha256:[a-f0-9]{64}$/.test(request.attachmentId)
          )
            return
          const reply = (ok, value) => {
            if (active)
              window.parent.postMessage(
                { type: 'dsh-studio:image-result', id: request.id, ok, value },
                event.origin,
              )
          }
          const fileRequest = request.kind === 'file' || request.kind === 'download'
          if (reading >= 4 || fileReads.has(request.id) || (!fileRequest && !readImage)) {
            reply(false)
            return
          }
          reading += 1
          try {
            if (fileRequest) {
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 20000)
              fileReads.set(request.id, controller)
              try {
                const query = new URLSearchParams({
                  sessionId: request.sessionId,
                  attachmentId: request.attachmentId,
                })
                const route = request.kind === 'download' ? 'file-download' : 'file-preview'
                const response = await fetch(`/api/studio/${route}?${query}`, {
                  signal: controller.signal,
                  credentials: 'same-origin',
                  cache: 'no-store',
                })
                if (!response.ok) {
                  reply(false)
                  return
                }
                const value = await response.json()
                const content = request.kind === 'download' ? value?.data : value?.text
                if (
                  typeof content !== 'string' ||
                  content.length > (request.kind === 'download' ? 27962028 : 1048576)
                )
                  reply(false)
                else reply(true, value)
              } finally {
                clearTimeout(timer)
                fileReads.delete(request.id)
              }
              return
            }
            const result = await readImage({
              sessionId: request.sessionId,
              attachmentId: request.attachmentId,
            })
            if (
              !result?.ok ||
              typeof result.value?.data !== 'string' ||
              result.value.data.length > 27962028
            )
              reply(false)
            else reply(true, result.value)
          } catch {
            reply(false)
          } finally {
            reading -= 1
          }
        }
        window.addEventListener('message', onImage)
        ctx.effect(
          () => () => {
            active = false
            for (const controller of fileReads.values()) controller.abort()
            window.removeEventListener('message', onImage)
          },
          'dsh-studio: authorized image preview',
        )
      }

      if (window.parent !== window) {
        const style = document.createElement('style')
        style.textContent = themeStyle
        document.head.append(style)
        const originalDark = document.body.hasAttribute('data-ds-dark-theme')
        const originalColorScheme = document.documentElement.style.colorScheme

        const onTheme = (event) => {
          if (event.source !== window.parent || event.data?.type !== 'dsh-studio:theme') return
          if (event.data.theme !== 'dark' && event.data.theme !== 'light') return
          document.body.dataset.dshStudioTheme = event.data.theme
          document.body.toggleAttribute('data-ds-dark-theme', event.data.theme === 'dark')
          document.documentElement.style.colorScheme = event.data.theme
        }
        window.addEventListener('message', onTheme)
        window.parent.postMessage({ type: 'dsh-studio:theme-ready' }, '*')
        ctx.effect(
          () => () => {
            window.removeEventListener('message', onTheme)
            style.remove()
            delete document.body.dataset.dshStudioTheme
            document.body.toggleAttribute('data-ds-dark-theme', originalDark)
            document.documentElement.style.colorScheme = originalColorScheme
          },
          'dsh-studio: theme',
        )
      }

      ctx.effect(
        () =>
          desktop.workspace.onDrop((path) => {
            void desktop.workspace
              .validate(path)
              .then((review) => {
                if (!review.allowed)
                  throw new Error(review.reason || 'DSH Studio rejected this workspace')
                return ctx.workspaces.create({ path })
              })
              .then((created) => {
                // Harness 0.1.2 wraps service results in a Result object.
                const workspace =
                  created && typeof created.ok === 'boolean'
                    ? created.ok
                      ? created.value.workspace
                      : null
                    : created
                if (!workspace) {
                  throw new Error(
                    (created && created.error && created.error.message) ||
                      'Workspace could not be created',
                  )
                }
                if (typeof ctx.uiWorkspace?.startSession === 'function') {
                  ctx.uiWorkspace.startSession(workspace.workspaceId)
                } else {
                  ctx.workspaces.startSession(workspace.workspaceId)
                }
              })
              .catch((reason) => {
                const body = reason instanceof Error ? reason.message : String(reason)
                void desktop.notify({ title: 'Workspace could not be added', body }).catch(() => {})
              })
          }),
        'dsh-studio: native workspace folder drop',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

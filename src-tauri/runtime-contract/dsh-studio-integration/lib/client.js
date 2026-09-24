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
        font-family: -apple-system-body, ui-sans-serif, -apple-system, BlinkMacSystemFont,
          'Segoe UI', Helvetica, 'PingFang SC', 'Microsoft YaHei UI', Arial, sans-serif !important;
        font-feature-settings: normal !important;
      }
      body[data-dsh-studio-theme] button,
      body[data-dsh-studio-theme] input,
      body[data-dsh-studio-theme] textarea {
        font-family: inherit;
      }
      body[data-dsh-studio-theme='dark'] {
        --dsw-alias-bg-base: #171717 !important;
        --dsw-alias-bg-layer-1: #242424 !important;
        --dsw-alias-bg-layer-2: #2f2f2f !important;
        --dsw-alias-bg-layer-3: #3a3a3a !important;
        --dsw-alias-bg-overlay: #242424 !important;
        --dsw-alias-border-l1: #ffffff12 !important;
        --dsw-alias-border-l2: #ffffff2a !important;
        --dsw-alias-border-l3: #ffffff40 !important;
        --dsw-alias-label-primary: #ededed !important;
        --dsw-alias-label-secondary: #b8b8b8 !important;
        --dsw-alias-label-tertiary: #858585 !important;
        --dsw-alias-brand-primary: #ededed !important;
        --dsw-alias-brand-text: #ededed !important;
        --dsw-alias-button-primary-fill: #ededed !important;
        --dsw-alias-button-primary-hover: #ffffff !important;
        --dsw-alias-interactive-bg-hover: #343434 !important;
        --dsw-alias-interactive-bg-active: #3a3a3a !important;
      }
      body[data-dsh-studio-theme='light'] {
        --dsw-alias-bg-base: #ffffff !important;
        --dsw-alias-bg-layer-1: #f7f7f5 !important;
        --dsw-alias-bg-layer-2: #efefed !important;
        --dsw-alias-bg-layer-3: #e7e7e5 !important;
        --dsw-alias-bg-overlay: #ffffff !important;
        --dsw-alias-border-l1: #17171712 !important;
        --dsw-alias-border-l2: #1717172a !important;
        --dsw-alias-border-l3: #17171740 !important;
        --dsw-alias-label-primary: #171717 !important;
        --dsw-alias-label-secondary: #5b5b5b !important;
        --dsw-alias-label-tertiary: #858585 !important;
        --dsw-alias-brand-primary: #171717 !important;
        --dsw-alias-brand-text: #171717 !important;
        --dsw-alias-button-primary-fill: #171717 !important;
        --dsw-alias-button-primary-hover: #343434 !important;
        --dsw-alias-interactive-bg-hover: #eaeae8 !important;
        --dsw-alias-interactive-bg-active: #e7e7e5 !important;
      }
    `

    function apply(ctx) {
      const desktop = window.dshStudio
      if (!desktop || !desktop.workspace || typeof desktop.workspace.onDrop !== 'function') return

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
        ctx.effect(() => {
          window.removeEventListener('message', onTheme)
          style.remove()
          delete document.body.dataset.dshStudioTheme
          document.body.toggleAttribute('data-ds-dark-theme', originalDark)
          document.documentElement.style.colorScheme = originalColorScheme
        }, 'dsh-studio: theme')
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

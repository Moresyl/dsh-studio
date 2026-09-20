window.__ModuleLoader__.load({
  id: '@moresyl/dsh-studio-integration',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // uiWorkspace exists from Harness 0.1.2; inject stays tolerant so either
    // generation loads (a missing service is skipped by the loader).
    const inject = ['workspaces', 'uiWorkspace']

    function apply(ctx) {
      const desktop = window.dshStudio
      if (!desktop || !desktop.workspace || typeof desktop.workspace.onDrop !== 'function') return

      ctx.effect(() => desktop.workspace.onDrop((path) => {
        void desktop.workspace.validate(path).then((review) => {
          if (!review.allowed) throw new Error(review.reason || 'DSH Studio rejected this workspace')
          return ctx.workspaces.create({ path })
        }).then((created) => {
          // Harness 0.1.2 wraps service results in a Result object.
          const workspace = created && typeof created.ok === 'boolean'
            ? (created.ok ? created.value.workspace : null)
            : created
          if (!workspace) {
            throw new Error((created && created.error && created.error.message) || 'Workspace could not be created')
          }
          if (typeof ctx.uiWorkspace?.startSession === 'function') {
            ctx.uiWorkspace.startSession(workspace.workspaceId)
          } else {
            ctx.workspaces.startSession(workspace.workspaceId)
          }
        }).catch((reason) => {
          const body = reason instanceof Error ? reason.message : String(reason)
          void desktop.notify({ title: 'Workspace could not be added', body }).catch(() => {})
        })
      }), 'dsh-studio: native workspace folder drop')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

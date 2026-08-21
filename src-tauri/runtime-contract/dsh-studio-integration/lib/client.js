window.__ModuleLoader__.load({
  id: '@moresyl/dsh-studio-integration',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const inject = ['workspaces']

    function apply(ctx) {
      const desktop = window.dshStudio
      if (!desktop || !desktop.workspace || typeof desktop.workspace.onDrop !== 'function') return

      ctx.effect(() => desktop.workspace.onDrop((path) => {
        void desktop.workspace.validate(path).then((review) => {
          if (!review.allowed) throw new Error(review.reason || 'DSH Studio rejected this workspace')
          return ctx.workspaces.create({ path })
        }).then((workspace) => {
          ctx.workspaces.startSession(workspace.workspaceId)
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

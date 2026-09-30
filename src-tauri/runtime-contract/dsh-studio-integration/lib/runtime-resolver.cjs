const { createRequire, registerHooks } = require('node:module')
const { pathToFileURL } = require('node:url')

const managedParentURL = pathToFileURL(__filename).href
const managedRequire = createRequire(__filename)
const managedScope = '@deepseek-ai/'
let resolvingRequire = false

/**
 * Keep the official Harness graph on the one version Studio qualified.
 *
 * Third-party Profile packages can leave older `@deepseek-ai/*` peers in their
 * local node_modules. Letting those copies win mixes two Harness releases in one
 * process: storage migration and even named ESM exports then disagree. Ordinary
 * third-party packages still resolve from the Profile; only the upstream scope
 * is pinned to the managed runtime.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (resolvingRequire || !specifier.startsWith(managedScope))
      return nextResolve(specifier, context)

    const originalParentURL = context.parentURL
    try {
      // CommonJS's continuation retains its original parent despite parentURL.
      // Resolve from our require with a synchronous re-entry guard; ESM can
      // continue directly and preserve its own conditional exports.
      if (Array.from(context.conditions).includes('require')) {
        resolvingRequire = true
        try {
          return { url: pathToFileURL(managedRequire.resolve(specifier)).href, shortCircuit: true }
        } finally {
          resolvingRequire = false
        }
      }
      return nextResolve(specifier, { ...context, parentURL: managedParentURL })
    } catch {
      // Preserve the Profile-side diagnostic for an official extension the
      // selected runtime genuinely does not ship.
      return nextResolve(specifier, { ...context, parentURL: originalParentURL })
    }
  },
})

const { createRequire, registerHooks } = require('node:module')
const { pathToFileURL } = require('node:url')

const managedRequire = createRequire(__filename)
const managedScope = '@deepseek-ai/'

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
    if (!specifier.startsWith(managedScope)) return nextResolve(specifier, context)

    try {
      return nextResolve(pathToFileURL(managedRequire.resolve(specifier)).href, context)
    } catch {
      // Preserve the Profile-side diagnostic for an official extension the
      // selected runtime genuinely does not ship.
      return nextResolve(specifier, context)
    }
  },
})

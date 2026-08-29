const { createRequire, registerHooks } = require('node:module')
const { pathToFileURL } = require('node:url')

const managedRequire = createRequire(__filename)
const managedScope = '@deepseek-ai/'

/**
 * Preserve normal Profile resolution and consult the qualified managed runtime
 * only when an official Harness package is otherwise unavailable. This keeps
 * Profile-installed packages authoritative while avoiding the Windows junction
 * fallback used by upstream DSH as a single point of failure.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (failure) {
      if (failure?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith(managedScope)) {
        throw failure
      }

      try {
        return nextResolve(pathToFileURL(managedRequire.resolve(specifier)).href, context)
      } catch {
        // Keep Node's original Profile-anchored diagnostic. It is more useful
        // than replacing it with a second miss from the managed installation.
        throw failure
      }
    }
  },
})

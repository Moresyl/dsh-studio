/** Protocol implemented by this SDK release. */
export const DSH_STUDIO_PROTOCOL = 3
/** Read-only Cordis Host service protocol implemented by this SDK release. */
export const DSH_STUDIO_HOST_PROTOCOL = 1

/**
 * Return the current Studio contract, or undefined in a browser/unsupported
 * Studio. The optional scope makes feature detection testable and iframe-safe.
 */
export function getDshStudio(scope = globalThis) {
  if ((typeof scope !== 'object' && typeof scope !== 'function') || scope === null) {
    return undefined
  }
  const desktop = scope.dshStudio
  if (typeof desktop !== 'object' || desktop === null) return undefined
  return desktop.protocol === DSH_STUDIO_PROTOCOL ? desktop : undefined
}

/** Return the current contract or fail with one stable, user-actionable error. */
export function requireDshStudio(scope = globalThis) {
  const desktop = getDshStudio(scope)
  if (desktop) return desktop

  const seen =
    (typeof scope === 'object' || typeof scope === 'function') && scope !== null
      ? scope.dshStudio?.protocol
      : undefined
  if (seen !== undefined) {
    throw new Error(
      `DSH Studio Protocol ${String(seen)} is not supported; this plugin requires Protocol ${DSH_STUDIO_PROTOCOL}`,
    )
  }
  throw new Error('DSH Studio Protocol 3 is not available in this page')
}

/** Check a capability returned by hello() without trusting a malformed value. */
export function hasDshStudioCapability(offer, capability) {
  return (
    typeof capability === 'string' &&
    capability.length > 0 &&
    Array.isArray(offer?.capabilities) &&
    offer.capabilities.includes(capability)
  )
}

/**
 * Subscribe to native folder drops and return the protocol disposer. The
 * handler is checked before touching the desktop so a programming error cannot
 * leave a partially registered listener.
 */
export function onDshStudioWorkspaceDrop(handler, scope = globalThis) {
  if (typeof handler !== 'function')
    throw new TypeError('workspace drop handler must be a function')
  return requireDshStudio(scope).workspace.onDrop(handler)
}

/** Feature-detect the read-only Host service without requiring DSH Studio. */
export function getDshStudioHost(ctx) {
  if ((typeof ctx !== 'object' && typeof ctx !== 'function') || ctx === null) {
    return undefined
  }
  const host = typeof ctx.get === 'function' ? ctx.get('dshStudioHost') : ctx.dshStudioHost
  if (typeof host !== 'object' || host === null) return undefined
  return host.protocol === DSH_STUDIO_HOST_PROTOCOL ? host : undefined
}

/** Require the current Host contract with a stable compatibility error. */
export function requireDshStudioHost(ctx) {
  const host = getDshStudioHost(ctx)
  if (host) return host
  const seen =
    (typeof ctx === 'object' || typeof ctx === 'function') && ctx !== null
      ? typeof ctx.get === 'function'
        ? ctx.get('dshStudioHost')?.protocol
        : ctx.dshStudioHost?.protocol
      : undefined
  if (seen !== undefined) {
    throw new Error(
      `DSH Studio Host Protocol ${String(seen)} is not supported; this plugin requires Host Protocol ${DSH_STUDIO_HOST_PROTOCOL}`,
    )
  }
  throw new Error('DSH Studio Host Protocol 1 is not available in this Harness')
}

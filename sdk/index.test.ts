import { describe, expect, it, vi } from 'vitest'

import {
  DSH_STUDIO_PROTOCOL,
  DSH_STUDIO_HOST_PROTOCOL,
  getDshStudio,
  getDshStudioHost,
  hasDshStudioCapability,
  onDshStudioWorkspaceDrop,
  requireDshStudio,
  requireDshStudioHost,
} from './index.js'

function desktop() {
  const dispose = vi.fn()
  const onDrop = vi.fn(() => dispose)
  return {
    contract: { protocol: DSH_STUDIO_PROTOCOL, workspace: { onDrop } },
    dispose,
    onDrop,
  }
}

describe('DSH Studio SDK', () => {
  it('detects exactly Protocol 3 and rejects missing or malformed scopes', () => {
    const value = desktop().contract
    expect(getDshStudio({ dshStudio: value })).toBe(value)
    expect(getDshStudio({ dshStudio: { protocol: 2 } })).toBeUndefined()
    expect(getDshStudio({ dshStudio: null })).toBeUndefined()
    expect(getDshStudio(null)).toBeUndefined()
  })

  it('reports absent and incompatible hosts without leaking implementation details', () => {
    expect(() => requireDshStudio({})).toThrow('Protocol 3 is not available')
    expect(() => requireDshStudio({ dshStudio: { protocol: 4 } })).toThrow(
      'Protocol 4 is not supported',
    )
  })

  it('checks only a readable non-empty advertised capability', () => {
    expect(hasDshStudioCapability({ capabilities: ['workspace'] }, 'workspace')).toBe(true)
    expect(hasDshStudioCapability({ capabilities: ['workspace'] }, '')).toBe(false)
    expect(hasDshStudioCapability({ capabilities: null }, 'workspace')).toBe(false)
    expect(hasDshStudioCapability(undefined, 'workspace')).toBe(false)
  })

  it('registers workspace drops and returns the native disposer', () => {
    const value = desktop()
    const handler = vi.fn()
    const dispose = onDshStudioWorkspaceDrop(handler, { dshStudio: value.contract })

    expect(value.onDrop).toHaveBeenCalledWith(handler)
    expect(dispose).toBe(value.dispose)
  })

  it('rejects an invalid drop handler before consulting the host', () => {
    const value = desktop()
    // @ts-expect-error Runtime callers can still arrive from untyped JavaScript.
    expect(() => onDshStudioWorkspaceDrop(null, { dshStudio: value.contract })).toThrow(TypeError)
    expect(value.onDrop).not.toHaveBeenCalled()
  })

  it('detects the read-only Host contract through Cordis or direct properties', () => {
    const host = { protocol: DSH_STUDIO_HOST_PROTOCOL }
    expect(getDshStudioHost({ get: vi.fn(() => host) })).toBe(host)
    expect(getDshStudioHost({ dshStudioHost: host })).toBe(host)
    expect(getDshStudioHost({ dshStudioHost: { protocol: 2 } })).toBeUndefined()
    expect(getDshStudioHost(null)).toBeUndefined()
  })

  it('reports absent and incompatible Host contracts', () => {
    expect(() => requireDshStudioHost({})).toThrow('Host Protocol 1 is not available')
    expect(() => requireDshStudioHost({ dshStudioHost: { protocol: 2 } })).toThrow(
      'Host Protocol 2 is not supported',
    )
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import { packageName } from '@/state/plugins'
import { usePlugins } from '@/state/plugins'

vi.mock('@/lib/ipc')

const installed = {
  name: '@local/example',
  spec: 'link:/Users/me/example',
  active: true,
  disabled: false,
  builtin: false,
  marketReceipt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  usePlugins.setState({
    selected: null,
    selectedSource: null,
    selectedVersion: null,
    detail: null,
    loadingDetail: false,
    error: null,
  })
})

describe('plugin installation identity', () => {
  it('keeps progress attached to the selected package when the install spec is pinned', () => {
    expect(packageName('plain-plugin@1.2.3')).toBe('plain-plugin')
    expect(packageName('@vendor/plugin@0.4.0')).toBe('@vendor/plugin')
    expect(packageName('@vendor/plugin')).toBe('@vendor/plugin')
  })
})

describe('installed plugin details', () => {
  it('opens a local link package without querying npm', () => {
    usePlugins.getState().selectInstalled(installed)

    const state = usePlugins.getState()
    expect(ipc.pluginDetail).not.toHaveBeenCalled()
    expect(state.selectedSource).toBe('profile')
    expect(state.detail).toMatchObject({
      name: '@local/example',
      version: 'link:/Users/me/example',
      source: 'link:/Users/me/example',
      bundle: true,
    })
    expect(state.loadingDetail).toBe(false)
  })

  it('still asks the selected catalog for registry metadata', async () => {
    vi.mocked(ipc.pluginDetail).mockResolvedValue({
      name: 'registry-plugin',
      version: '1.2.3',
      description: '',
      license: 'MIT',
      homepage: null,
      repository: null,
      bundle: true,
      dependencies: [],
      installSpec: 'registry-plugin@1.2.3',
      source: 'npm',
      compatibility: { state: 'compatible', requirement: '*' },
      integrity: 'sha512-test',
      bundlePatch: null,
      lifecycleScripts: [],
      deprecated: null,
      repositoryVerified: true,
      integrityVerified: true,
    })

    await usePlugins.getState().select('registry-plugin', 'npm', '1.2.3')

    expect(ipc.pluginDetail).toHaveBeenCalledWith('npm', 'registry-plugin', '1.2.3')
    expect(usePlugins.getState().detail?.version).toBe('1.2.3')
  })
})

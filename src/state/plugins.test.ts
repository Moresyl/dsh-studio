import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { PluginDetail, PluginInstallPreview } from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
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

const detail = (version: string): PluginDetail => ({
  name: 'registry-plugin',
  version,
  description: '',
  license: 'MIT',
  homepage: null,
  repository: null,
  bundle: true,
  dependencies: [],
  installSpec: `registry-plugin@${version}`,
  source: 'npm',
  compatibility: { state: 'compatible', requirement: '*' },
  integrity: 'sha512-test',
  bundlePatch: null,
  lifecycleScripts: [],
  deprecated: null,
  repositoryVerified: true,
  integrityVerified: true,
})

beforeEach(() => {
  vi.clearAllMocks()
  usePlugins.setState({
    selected: null,
    selectedSource: null,
    selectedVersion: null,
    detail: null,
    loadingDetail: false,
    previewing: false,
    previewToken: null,
    previewExpiresAt: null,
    sourceWorking: false,
    sourceHealth: {},
    checkingSource: null,
    working: null,
    error: null,
  })
  useDialog.setState({ pending: null })
})

afterEach(() => vi.useRealTimers())

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
    vi.mocked(ipc.pluginDetail).mockResolvedValue(detail('1.2.3'))

    await usePlugins.getState().select('registry-plugin', 'npm', '1.2.3')

    expect(ipc.pluginDetail).toHaveBeenCalledWith('npm', 'registry-plugin', '1.2.3')
    expect(usePlugins.getState().detail?.version).toBe('1.2.3')
  })

  it('keeps loading when an older version of the same package finishes first', async () => {
    let finishOld!: (answer: PluginDetail) => void
    let finishNew!: (answer: PluginDetail) => void
    vi.mocked(ipc.pluginDetail)
      .mockReturnValueOnce(
        new Promise<PluginDetail>((resolve) => {
          finishOld = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise<PluginDetail>((resolve) => {
          finishNew = resolve
        }),
      )

    const oldRequest = usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    const newRequest = usePlugins.getState().select('registry-plugin', 'npm', '2.0.0')
    finishOld(detail('1.0.0'))
    await oldRequest

    expect(usePlugins.getState().loadingDetail).toBe(true)
    expect(usePlugins.getState().detail).toBeNull()

    finishNew(detail('2.0.0'))
    await newRequest

    expect(usePlugins.getState().loadingDetail).toBe(false)
    expect(usePlugins.getState().detail?.version).toBe('2.0.0')
  })
})

describe('plugin install previews', () => {
  it('drops a preview token when the selected package changes before verification finishes', async () => {
    let finishPreview!: (answer: PluginInstallPreview) => void
    vi.mocked(ipc.pluginDetail).mockResolvedValue(detail('1.0.0'))
    vi.mocked(ipc.pluginPreview).mockReturnValue(
      new Promise((resolve) => {
        finishPreview = resolve
      }),
    )

    await usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    const pending = usePlugins.getState().preview('registry-plugin@1.0.0')
    await usePlugins.getState().select('another-plugin', 'npm', '1.0.0')
    finishPreview({ token: 'old-package-token', expiresInSeconds: 300 })

    await expect(pending).resolves.toBe(false)
    expect(usePlugins.getState().previewing).toBe(false)
    expect(usePlugins.getState().previewToken).toBeNull()
  })

  it('revalidates an expired review at the confirming click before installing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T08:00:00Z'))
    vi.mocked(ipc.pluginDetail).mockResolvedValue(detail('1.0.0'))
    vi.mocked(ipc.pluginPreview)
      .mockResolvedValueOnce({ token: 'review-token', expiresInSeconds: 120 })
      .mockResolvedValueOnce({ token: 'fresh-token', expiresInSeconds: 120 })
    vi.mocked(ipc.pluginAdd).mockResolvedValue({
      profile: 'web',
      profileDir: 'C:/Users/test/.dsh/profiles/web',
      initialized: true,
      plugins: [],
      packageManager: true,
    })

    await usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    await expect(usePlugins.getState().preview('registry-plugin@1.0.0')).resolves.toBe(true)
    vi.advanceTimersByTime(120_001)

    await expect(usePlugins.getState().add()).resolves.toBe(true)
    expect(ipc.pluginPreview).toHaveBeenCalledTimes(2)
    expect(ipc.pluginAdd).toHaveBeenCalledWith('fresh-token')
    expect(usePlugins.getState().previewToken).toBeNull()
    expect(usePlugins.getState().previewExpiresAt).toBeNull()
  })

  it('returns to a fresh review after a consumed install attempt fails', async () => {
    vi.mocked(ipc.pluginDetail).mockResolvedValue(detail('1.0.0'))
    vi.mocked(ipc.pluginPreview).mockResolvedValue({
      token: 'one-shot-token',
      expiresInSeconds: 120,
    })
    vi.mocked(ipc.pluginAdd).mockRejectedValue(new Error('registry unavailable'))

    await usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    await usePlugins.getState().preview('registry-plugin@1.0.0')

    await expect(usePlugins.getState().add()).resolves.toBe(false)
    expect(usePlugins.getState().error).toContain('registry unavailable')
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'registry unavailable',
    })
    expect(usePlugins.getState().previewToken).toBeNull()
    expect(usePlugins.getState().previewExpiresAt).toBeNull()
  })
})

describe('plugin catalog source changes', () => {
  it('serializes source edits that target the same settings document', async () => {
    let finish!: (answer: []) => void
    vi.mocked(ipc.pluginSourceAdd).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    const first = usePlugins.getState().addSource('One', 'https://one.example/catalog.json')
    await expect(
      usePlugins.getState().addSource('Two', 'https://two.example/catalog.json'),
    ).resolves.toBe(false)

    expect(ipc.pluginSourceAdd).toHaveBeenCalledOnce()
    expect(usePlugins.getState().sourceWorking).toBe(true)
    finish([])
    await expect(first).resolves.toBe(true)
    expect(usePlugins.getState().sourceWorking).toBe(false)
  })

  it('stores a fresh source contract report and blocks overlapping probes', async () => {
    let finish!: (answer: ipc.CatalogHealth) => void
    vi.mocked(ipc.pluginSourceHealth).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    const first = usePlugins.getState().checkSource('dshfind')
    await usePlugins.getState().checkSource('npm')
    expect(ipc.pluginSourceHealth).toHaveBeenCalledOnce()
    expect(usePlugins.getState().checkingSource).toBe('dshfind')

    finish({
      sourceId: 'dshfind',
      contract: 'reviewed-http/dshfind-v1',
      checkedAt: 1,
      items: 12,
      installable: 12,
      latencyMs: 42,
      warnings: [],
    })
    await first
    expect(usePlugins.getState().sourceHealth.dshfind).toMatchObject({ items: 12, latencyMs: 42 })
    expect(usePlugins.getState().checkingSource).toBeNull()
  })

  it('shows source contract failures in the global error dialog', async () => {
    vi.mocked(ipc.pluginSourceHealth).mockRejectedValue(new Error('catalog schema drift'))

    await usePlugins.getState().checkSource('dshfind')

    expect(usePlugins.getState().error).toContain('catalog schema drift')
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'catalog schema drift',
    })
  })
})

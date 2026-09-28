import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { PluginDetail, PluginInstallPreview } from '@/lib/ipc'
import { useDialog } from '@/state/dialog'
import { installedPlugin, isInstalled, packageName } from '@/state/plugins'
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

const profileState: ipc.PluginState = {
  profile: 'web',
  profileDir: 'D:/qa/profiles/web',
  initialized: true,
  plugins: [installed],
  packageManager: true,
}
const archiveFixture: ipc.ArchivePackage = {
  name: '@local/archive',
  version: '1.0.0',
  description: '',
  bundle: true,
  path: 'D:/qa/archive.tgz',
  bytes: 128,
  integrity: 'sha256:reviewed',
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
  trust: { level: 'verified', signals: [] },
  resources: {
    directDependencies: 0,
    unpackedBytes: null,
    publishedFiles: null,
    nativeBuildDeclared: false,
  },
})

beforeEach(() => {
  vi.resetAllMocks()
  usePlugins.setState({
    profile: null,
    results: [],
    categories: [],
    total: 0,
    page: 0,
    pageSize: 25,
    hasMore: false,
    indexedAt: 0,
    sources: [],
    selected: null,
    selectedSource: null,
    selectedVersion: null,
    detail: null,
    loadingDetail: false,
    searching: false,
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

  it('binds an archive install to the digest shown in its review', async () => {
    vi.mocked(ipc.pluginImport).mockResolvedValue({
      profile: 'web',
      profileDir: 'C:/Users/test/.dsh/profiles/web',
      initialized: true,
      plugins: [],
      packageManager: true,
    })
    const archive: ipc.ArchivePackage = {
      name: '@local/archive',
      version: '1.0.0',
      description: '',
      bundle: true,
      path: 'C:/Downloads/archive.tgz',
      bytes: 128,
      integrity: 'sha256:reviewed',
    }

    await usePlugins.getState().bringIn(archive)

    expect(ipc.pluginImport).toHaveBeenCalledWith(archive.path, archive.integrity)
  })
})

describe('installed plugin details', () => {
  it('reports a current detail failure and clears it when the same item is retried', async () => {
    vi.mocked(ipc.pluginDetail)
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValueOnce(detail('1.0.0'))
    await usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    expect(usePlugins.getState()).toMatchObject({
      detail: null,
      loadingDetail: false,
      error: 'metadata unavailable',
    })
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'metadata unavailable',
    })
    useDialog.getState().settle(false)
    await usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    expect(usePlugins.getState()).toMatchObject({ detail: detail('1.0.0'), error: null })
  })
  it('ignores an old detail snapshot after the same item is reopened', async () => {
    let finishOld!: (value: PluginDetail) => void
    vi.mocked(ipc.pluginDetail)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve
        }),
      )
      .mockResolvedValueOnce({ ...detail('1.0.0'), description: 'fresh metadata' })
    const old = usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    await usePlugins.getState().select(null)
    const closedLoading = usePlugins.getState().loadingDetail
    await usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    finishOld({ ...detail('1.0.0'), description: 'stale metadata' })
    await old
    expect(closedLoading).toBe(false)
    expect(usePlugins.getState().detail?.description).toBe('fresh metadata')
  })

  it('keeps an obsolete detail failure from interrupting a reopened item', async () => {
    let rejectOld!: (cause: Error) => void
    vi.mocked(ipc.pluginDetail)
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectOld = reject
        }),
      )
      .mockResolvedValueOnce(detail('1.0.0'))
    const old = usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    await usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    rejectOld(new Error('obsolete failure'))
    await old
    expect(usePlugins.getState().error).toBeNull()
    expect(useDialog.getState().pending).toBeNull()
  })

  it('keeps the newer identical-item request loading until its own answer arrives', async () => {
    let finishOld!: (value: PluginDetail) => void
    let finishNew!: (value: PluginDetail) => void
    vi.mocked(ipc.pluginDetail)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishNew = resolve
        }),
      )
    const old = usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    const fresh = usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    finishOld(detail('1.0.0'))
    await old
    expect(usePlugins.getState().loadingDetail).toBe(true)
    expect(usePlugins.getState().detail).toBeNull()
    finishNew(detail('1.0.0'))
    await fresh
    expect(usePlugins.getState().loadingDetail).toBe(false)
  })
  it('shows the installed package version while retaining the requested source range', () => {
    usePlugins
      .getState()
      .selectInstalled({ ...installed, spec: '^0.2.0', installedVersion: '0.2.4' })
    expect(usePlugins.getState().detail).toMatchObject({ version: '0.2.4', source: '^0.2.0' })
  })
  it('preserves an installed module compatibility failure in its detail review', () => {
    const compatibility = {
      state: 'incompatible' as const,
      requirement: '0.1.0-rc.6',
      reason: 'dsh-tools requires 0.1.0-rc.6',
    }
    usePlugins.getState().selectInstalled({ ...installed, compatibility })
    expect(usePlugins.getState().detail?.compatibility).toEqual(compatibility)
    expect(ipc.pluginDetail).not.toHaveBeenCalled()
  })

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
  it('keeps automatic search failures inline but reports an explicit retry failure', async () => {
    vi.mocked(ipc.pluginSearch).mockRejectedValue(new Error('catalog offline'))
    await usePlugins.getState().search('tool', null, 'relevance', 0)
    expect(usePlugins.getState().error).toBe('catalog offline')
    expect(usePlugins.getState().searching).toBe(false)
    expect(useDialog.getState().pending).toBeNull()
    await usePlugins.getState().search('tool', null, 'relevance', 0, true)
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'catalog offline',
    })
  })

  it('does not interrupt the current page for a background catalog-state failure', async () => {
    vi.mocked(ipc.pluginState).mockRejectedValue(new Error('profile unavailable'))
    vi.mocked(ipc.pluginSources).mockResolvedValue([])
    await usePlugins.getState().refresh()
    expect(usePlugins.getState().error).toBe('profile unavailable')
    expect(useDialog.getState().pending).toBeNull()
  })
  it('drops a slow search when the active source changes underneath it', async () => {
    let finishSearch!: (answer: Awaited<ReturnType<typeof ipc.pluginSearch>>) => void
    vi.mocked(ipc.pluginSearch).mockReturnValue(
      new Promise((resolve) => {
        finishSearch = resolve
      }),
    )
    vi.mocked(ipc.pluginSourceSelect).mockResolvedValue([
      {
        id: 'other',
        label: 'Other',
        kind: 'standard-http-v1',
        endpoint: 'https://other.example',
        builtIn: false,
        active: true,
      },
    ])

    const search = usePlugins.getState().search('tool', null, 'relevance', 0)
    const switchSource = usePlugins.getState().selectSource('other')
    await switchSource
    finishSearch({
      items: [{ name: 'stale-tool' } as never],
      categories: ['stale'],
      total: 1,
      page: 0,
      pageSize: 25,
      hasMore: false,
      indexedAt: 1,
    })
    await search

    expect(usePlugins.getState().results).toEqual([])
    expect(usePlugins.getState().categories).toEqual([])
    expect(usePlugins.getState().searching).toBe(false)
  })

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

  it('drops source health that returns after that source was removed', async () => {
    let finishHealth!: (answer: ipc.CatalogHealth) => void
    vi.mocked(ipc.pluginSourceHealth).mockReturnValue(
      new Promise((resolve) => {
        finishHealth = resolve
      }),
    )
    vi.mocked(ipc.pluginSourceRemove).mockResolvedValue([])

    const probe = usePlugins.getState().checkSource('retired')
    await usePlugins.getState().removeSource('retired')
    finishHealth({
      sourceId: 'retired',
      contract: 'standard-v1',
      checkedAt: 1,
      items: 1,
      installable: 1,
      latencyMs: 5,
      warnings: [],
    })
    await probe

    expect(usePlugins.getState().sourceHealth.retired).toBeUndefined()
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

describe('catalog state and mutation recovery', () => {
  it('refreshes profile and sources but ignores a refresh overtaken by a plugin mutation', async () => {
    vi.mocked(ipc.pluginState).mockResolvedValueOnce(profileState)
    vi.mocked(ipc.pluginSources).mockResolvedValue([])
    await usePlugins.getState().refresh()
    expect(usePlugins.getState().profile).toEqual(profileState)
    let finish!: (value: ipc.PluginState) => void
    vi.mocked(ipc.pluginState).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const old = usePlugins.getState().refresh()
    vi.mocked(ipc.pluginRemove).mockResolvedValueOnce({ ...profileState, plugins: [] })
    await usePlugins.getState().remove(installed.name)
    finish(profileState)
    await old
    expect(usePlugins.getState().profile?.plugins).toEqual([])
  })

  it('takes the newest search snapshot, including pagination and available-only intent', async () => {
    let finish!: (value: Awaited<ReturnType<typeof ipc.pluginSearch>>) => void
    const answer = {
      items: [],
      categories: ['tools'],
      total: 26,
      page: 1,
      pageSize: 25,
      hasMore: false,
      indexedAt: 123,
    }
    vi.mocked(ipc.pluginSearch)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        }),
      )
      .mockResolvedValueOnce(answer)
    const old = usePlugins.getState().search('old', null, 'relevance', 0)
    await usePlugins.getState().search('fresh', 'tools', 'relevance', 1, false, true)
    finish({ ...answer, total: 1, page: 0 })
    await old
    expect(usePlugins.getState()).toMatchObject({
      categories: ['tools'],
      total: 26,
      page: 1,
      indexedAt: 123,
      searching: false,
    })
    expect(ipc.pluginSearch).toHaveBeenLastCalledWith('fresh', 'tools', 'relevance', 1, false, true)
  })

  it.each(['remove', 'toggle', 'bringIn'] as const)(
    '%s publishes only a successful native result and recovers after failure',
    async (action) => {
      const command =
        action === 'remove'
          ? ipc.pluginRemove
          : action === 'toggle'
            ? ipc.pluginSwitch
            : ipc.pluginImport
      vi.mocked(command)
        .mockResolvedValueOnce(profileState)
        .mockRejectedValueOnce(new Error('mutation refused'))
      const run = () =>
        action === 'remove'
          ? usePlugins.getState().remove(installed.name)
          : action === 'toggle'
            ? usePlugins.getState().toggle(installed.name, false)
            : usePlugins.getState().bringIn(archiveFixture)
      await run()
      expect(usePlugins.getState().profile).toEqual(profileState)
      expect(ipc.announce).toHaveBeenCalledWith('profiles')
      await run()
      expect(usePlugins.getState()).toMatchObject({
        profile: profileState,
        working: null,
        error: 'mutation refused',
      })
      expect(useDialog.getState().pending).toMatchObject({
        kind: 'error',
        details: 'mutation refused',
      })
    },
  )

  it('does not overlap plugin writes or background refresh with an active write', async () => {
    usePlugins.setState({ working: 'busy' })
    await usePlugins.getState().refresh()
    await usePlugins.getState().remove('another')
    await usePlugins.getState().toggle('another', true)
    await usePlugins.getState().bringIn(archiveFixture)
    await expect(usePlugins.getState().add()).resolves.toBe(false)
    await expect(usePlugins.getState().preview('another@1.0.0')).resolves.toBe(false)
    for (const command of [
      ipc.pluginState,
      ipc.pluginRemove,
      ipc.pluginSwitch,
      ipc.pluginImport,
      ipc.pluginAdd,
      ipc.pluginPreview,
    ])
      expect(command).not.toHaveBeenCalled()
  })

  it('inspects archives without installing them and reports invalid archive errors', async () => {
    vi.mocked(ipc.pluginArchive)
      .mockResolvedValueOnce(archiveFixture)
      .mockRejectedValueOnce(new Error('invalid tarball'))
    await expect(usePlugins.getState().inspect(archiveFixture.path)).resolves.toEqual(
      archiveFixture,
    )
    expect(ipc.pluginImport).not.toHaveBeenCalled()
    await expect(usePlugins.getState().inspect('D:/bad.tgz')).resolves.toBeNull()
    expect(usePlugins.getState().error).toBe('invalid tarball')
  })

  it.each(['select', 'add', 'remove'] as const)(
    'recovers a failed source %s without leaving the source controls busy',
    async (action) => {
      const command =
        action === 'select'
          ? ipc.pluginSourceSelect
          : action === 'add'
            ? ipc.pluginSourceAdd
            : ipc.pluginSourceRemove
      vi.mocked(command).mockRejectedValueOnce(new Error('source rejected'))
      if (action === 'select') await usePlugins.getState().selectSource('other')
      else if (action === 'add')
        await expect(
          usePlugins.getState().addSource('Other', 'https://example.invalid/catalog'),
        ).resolves.toBe(false)
      else await usePlugins.getState().removeSource('other')
      expect(usePlugins.getState()).toMatchObject({
        sourceWorking: false,
        searching: false,
        error: 'source rejected',
      })
    },
  )

  it('blocks source edits during plugin writes', async () => {
    usePlugins.setState({ working: 'busy' })
    await usePlugins.getState().selectSource('other')
    await expect(usePlugins.getState().addSource('Other', 'https://example.invalid')).resolves.toBe(
      false,
    )
    await usePlugins.getState().removeSource('other')
    expect(ipc.pluginSourceSelect).not.toHaveBeenCalled()
    expect(ipc.pluginSourceAdd).not.toHaveBeenCalled()
    expect(ipc.pluginSourceRemove).not.toHaveBeenCalled()
  })

  it('refuses install without a current selection or metadata and reports preview failures', async () => {
    await expect(usePlugins.getState().add()).resolves.toBe(false)
    await expect(usePlugins.getState().preview('missing@1.0.0')).resolves.toBe(false)
    expect(ipc.pluginPreview).not.toHaveBeenCalled()
    vi.mocked(ipc.pluginDetail).mockResolvedValueOnce(detail('1.0.0'))
    await usePlugins.getState().select('registry-plugin', 'npm', '1.0.0')
    vi.mocked(ipc.pluginPreview).mockRejectedValueOnce(new Error('integrity unavailable'))
    await expect(usePlugins.getState().add()).resolves.toBe(false)
    expect(usePlugins.getState()).toMatchObject({
      previewing: false,
      previewToken: null,
      error: 'integrity unavailable',
    })
    expect(ipc.pluginAdd).not.toHaveBeenCalled()
  })

  it('uses a current one-shot token without another network preview', async () => {
    usePlugins.setState({
      selected: 'registry-plugin',
      previewToken: 'current',
      previewExpiresAt: Date.now() + 60000,
    })
    vi.mocked(ipc.pluginAdd).mockResolvedValueOnce(profileState)
    await expect(usePlugins.getState().add()).resolves.toBe(true)
    expect(ipc.pluginPreview).not.toHaveBeenCalled()
    expect(ipc.pluginAdd).toHaveBeenCalledWith('current')
    expect(usePlugins.getState().previewToken).toBeNull()
  })

  it('looks up installed identities and handles empty bundled metadata', () => {
    expect(installedPlugin(null, 'missing')).toBeNull()
    expect(installedPlugin(profileState, null)).toBeNull()
    expect(installedPlugin(profileState, 'missing')).toBeNull()
    expect(installedPlugin(profileState, installed.name)).toEqual(installed)
    expect(isInstalled(null, installed.name)).toBe(false)
    expect(isInstalled(profileState, installed.name)).toBe(true)
    usePlugins.getState().selectInstalled({ ...installed, spec: '', active: false, builtin: true })
    expect(usePlugins.getState().detail).toMatchObject({
      version: 'bundled',
      source: 'profile bundle',
      bundle: true,
      compatibility: { state: 'unknown' },
    })
  })
})

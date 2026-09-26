import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { PresetRoster } from '@/lib/ipc'
import { t } from '@/lib/i18n'
import { ask } from '@/state/dialog'
import { importPresetPackage, isPresetPackagePath, usePresets } from '@/state/presets'

vi.mock('@/lib/ipc')
vi.mock('@/state/dialog', () => ({ ask: vi.fn() }))

const roster = (chosen: string): PresetRoster => ({
  presets: [
    { id: 'general', name: 'General', description: null, shipped: true },
    { id: 'coding', name: 'Coding', description: null, shipped: true },
    { id: 'research', name: 'Research', description: null, shipped: true },
  ],
  default: chosen,
})

beforeEach(() => {
  vi.clearAllMocks()
  usePresets.setState({
    presets: roster('general').presets,
    chosen: 'general',
    loading: false,
    error: null,
  })
})

describe('agent preset selection', () => {
  it('recognizes portable preset paths without confusing ordinary files', () => {
    expect(isPresetPackagePath('C:/Users/me/portable.dshpreset')).toBe(true)
    expect(isPresetPackagePath('/tmp/PORTABLE.DSHPRESET')).toBe(true)
    expect(isPresetPackagePath('/tmp/portable.dshpreset.zip')).toBe(false)
    expect(isPresetPackagePath('/tmp/workspace')).toBe(false)
  })

  it('keeps the newest choice when older requests finish later', async () => {
    let finishCoding!: (answer: PresetRoster) => void
    vi.mocked(ipc.presetChoose)
      .mockReturnValueOnce(
        new Promise<PresetRoster>((resolve) => {
          finishCoding = resolve
        }),
      )
      .mockResolvedValueOnce(roster('research'))

    const coding = usePresets.getState().choose('coding')
    await usePresets.getState().choose('research')
    finishCoding(roster('coding'))
    await coding

    expect(usePresets.getState().chosen).toBe('research')
  })

  it('does not let an older refresh overwrite a newer choice', async () => {
    let finishRefresh!: (answer: PresetRoster) => void
    vi.mocked(ipc.presetRoster).mockReturnValue(
      new Promise<PresetRoster>((resolve) => {
        finishRefresh = resolve
      }),
    )
    vi.mocked(ipc.presetChoose).mockResolvedValue(roster('coding'))

    const refresh = usePresets.getState().refresh()
    await usePresets.getState().choose('coding')
    finishRefresh(roster('general'))
    await refresh

    expect(usePresets.getState().chosen).toBe('coding')
  })

  it('ignores a failure from a superseded choice', async () => {
    let failCoding!: (cause: unknown) => void
    vi.mocked(ipc.presetChoose)
      .mockReturnValueOnce(
        new Promise<PresetRoster>((_resolve, reject) => {
          failCoding = reject
        }),
      )
      .mockResolvedValueOnce(roster('research'))

    const coding = usePresets.getState().choose('coding')
    await usePresets.getState().choose('research')
    failCoding('old request failed')
    await coding

    expect(usePresets.getState().chosen).toBe('research')
    expect(usePresets.getState().error).toBeNull()
  })

  it('previews and confirms a native package before importing it', async () => {
    vi.mocked(ipc.presetPackage).mockResolvedValue({
      id: 'portable',
      name: 'Portable agent',
      description: null,
      files: 3,
      bytes: 2048,
      integrityVerified: true,
    })
    vi.mocked(ask).mockResolvedValue(true)
    vi.mocked(ipc.presetImport).mockResolvedValue({
      presets: [
        ...roster('general').presets,
        { id: 'portable', name: 'Portable agent', description: null, shipped: false },
      ],
      default: 'general',
    })

    await expect(importPresetPackage('C:/Users/me/portable.dshpreset')).resolves.toBe(true)

    expect(ipc.presetPackage).toHaveBeenCalledWith('C:/Users/me/portable.dshpreset')
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: t('preset.importConfirmTitle'),
        subject: 'Portable agent (portable)',
        confirm: t('preset.importConfirm'),
      }),
    )
    expect(ipc.presetImport).toHaveBeenCalledWith('C:/Users/me/portable.dshpreset')
    expect(usePresets.getState().presets.at(-1)?.id).toBe('portable')
  })

  it('leaves disk unchanged when the package trust warning is declined', async () => {
    vi.mocked(ipc.presetPackage).mockResolvedValue({
      id: 'portable',
      name: null,
      description: null,
      files: 1,
      bytes: 12,
      integrityVerified: true,
    })
    vi.mocked(ask).mockResolvedValue(false)

    await expect(importPresetPackage('portable.dshpreset')).resolves.toBe(false)
    expect(ipc.presetImport).not.toHaveBeenCalled()
  })

  it('never asks to import a package that failed integrity verification', async () => {
    vi.mocked(ipc.presetPackage).mockResolvedValue({
      id: 'portable',
      name: null,
      description: null,
      files: 1,
      bytes: 12,
      integrityVerified: false,
    })

    await expect(importPresetPackage('portable.dshpreset')).rejects.toThrow(
      t('preset.integrityFailed'),
    )
    expect(ask).not.toHaveBeenCalled()
    expect(ipc.presetImport).not.toHaveBeenCalled()
  })
})

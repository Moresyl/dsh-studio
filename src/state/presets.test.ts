import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as ipc from '@/lib/ipc'
import type { PresetRoster } from '@/lib/ipc'
import { usePresets } from '@/state/presets'

vi.mock('@/lib/ipc')

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
})

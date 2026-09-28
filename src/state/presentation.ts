import { create } from 'zustand'

import { announce, onSharedChange } from '@/lib/ipc'
import { readPreference, savePreference } from '@/lib/preferences'

export type Presentation = 'compatibility' | 'extended' | 'advanced'

const KEY = 'dsh-studio.presentation'

function remembered(): Presentation {
  const saved = readPreference(KEY)
  return saved === 'advanced' || saved === 'extended' ? saved : 'compatibility'
}

interface PresentationState {
  mode: Presentation
  choose: (mode: Presentation) => void
}

export const usePresentation = create<PresentationState>((set) => ({
  mode: remembered(),
  choose: (mode) => {
    savePreference(KEY, mode)
    set({ mode })
    void announce('presentation')
  },
}))

void onSharedChange((subject) => {
  if (subject !== 'presentation') return
  const mode = remembered()
  if (mode !== usePresentation.getState().mode) usePresentation.setState({ mode })
})

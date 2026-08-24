import { create } from 'zustand'

import { announce, onSharedChange } from '@/lib/ipc'

export type Presentation = 'compatibility' | 'extended' | 'advanced'

const KEY = 'dsh-studio.presentation'

function remembered(): Presentation {
  try {
    const saved = window.localStorage.getItem(KEY)
    return saved === 'advanced' || saved === 'extended' ? saved : 'compatibility'
  } catch {
    return 'compatibility'
  }
}

interface PresentationState {
  mode: Presentation
  choose: (mode: Presentation) => void
}

export const usePresentation = create<PresentationState>((set) => ({
  mode: remembered(),
  choose: (mode) => {
    try {
      window.localStorage.setItem(KEY, mode)
    } catch {
      // The live choice remains useful even if this webview cannot persist it.
    }
    set({ mode })
    void announce('presentation')
  },
}))

void onSharedChange((subject) => {
  if (subject !== 'presentation') return
  const mode = remembered()
  if (mode !== usePresentation.getState().mode) usePresentation.setState({ mode })
})

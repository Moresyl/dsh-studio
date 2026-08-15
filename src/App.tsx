import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { Ambient } from '@/components/Ambient'
import { HarnessFrame } from '@/components/HarnessFrame'
import { Launcher } from '@/components/Launcher'
import { TitleBar } from '@/components/TitleBar'
import { subscribeToHarness, useHarness } from '@/state/harness'

/**
 * Two layers under one title bar.
 *
 * The control panel is what a user sees before the harness is serving, and what
 * they can always return to afterwards; the harness itself is a frame that
 * stays loaded underneath. Neither replaces the window, so the shell keeps its
 * chrome and its supervisor no matter which one is in front.
 */
export default function App() {
  const status = useHarness((state) => state.status)
  const origin = status.phase === 'ready' ? status.origin : null

  // Which harness the user asked to look away from, rather than a bare boolean.
  // Tying the request to an origin means a newly started harness is shown
  // without an effect having to reach in and reset a flag — and a restart, which
  // lands on a fresh port, is a new origin and so gets the same treatment.
  const [panelFor, setPanelFor] = useState<string | null>(null)

  // The window was created hidden. Reveal it once there is something in it.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void getCurrentWindow().show()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const pending = subscribeToHarness()
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [])

  // With nothing serving there is nothing else to show.
  const showPanel = origin === null || panelFor === origin

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-canvas">
      {/* Only under our own surface. With the harness in front the ambient is
          visible through nothing but the title bar, where a coloured wash
          against the harness's flat dark reads as two apps stacked. */}
      {showPanel && <Ambient />}
      <TitleBar
        origin={origin}
        panelOpen={showPanel}
        onTogglePanel={
          origin ? () => setPanelFor((current) => (current === origin ? null : origin)) : undefined
        }
      />

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        {origin && <HarnessFrame origin={origin} hidden={showPanel} />}
        {showPanel && (
          <div className="flex min-h-0 flex-1 animate-rise flex-col">
            <Launcher />
          </div>
        )}
      </div>
    </div>
  )
}

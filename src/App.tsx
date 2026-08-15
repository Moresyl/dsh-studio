import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { HarnessFrame } from '@/components/HarnessFrame'
import { Launcher } from '@/components/Launcher'
import { StatusBar } from '@/components/StatusBar'
import { TitleBar } from '@/components/TitleBar'
import { subscribeToHarness, useHarness } from '@/state/harness'

/**
 * The window: a title bar, a status bar, and whichever view is between them.
 *
 * The two strips never go away, whatever is in the middle. That is the whole
 * difference between an application window and a page — the frame is a constant
 * the user can rely on, so the harness can take the content area without taking
 * the controls or the readout with it.
 */
export default function App() {
  const status = useHarness((state) => state.status)
  const environment = useHarness((state) => state.environment)
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
    <div className="flex h-full flex-col overflow-hidden bg-canvas">
      <TitleBar
        serving={origin !== null}
        panelOpen={showPanel}
        onTogglePanel={
          origin ? () => setPanelFor((current) => (current === origin ? null : origin)) : undefined
        }
      />

      <div className="relative flex min-h-0 flex-1">
        {origin && <HarnessFrame origin={origin} hidden={showPanel} />}
        {showPanel && <Launcher />}
      </div>

      <StatusBar status={status} environment={environment} />
    </div>
  )
}

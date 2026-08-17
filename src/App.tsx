import { useCallback, useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { ContextMenu } from '@/components/ContextMenu'
import { Dialog } from '@/components/Dialog'
import { HarnessFrame } from '@/components/HarnessFrame'
import { Onboarding } from '@/components/Onboarding'
import { ProfileManager } from '@/components/ProfileManager'
import { StatusBar } from '@/components/StatusBar'
import { TitleBar } from '@/components/TitleBar'
import { Tooltip } from '@/components/Tooltip'
import { Workbench, VIEWS, type View } from '@/components/Workbench'
import { useDialog } from '@/state/dialog'
import { subscribeToHarness, useHarness } from '@/state/harness'
import { useOnboarding } from '@/state/onboarding'
import { subscribeToRemote, useRemote } from '@/state/remote'
import { subscribeToTerminals } from '@/state/terminals'
import { watchForUpdates } from '@/state/update'

/**
 * The window: a title bar, a status bar, and whichever view is between them.
 *
 * The two strips never go away, whatever is in the middle. That is the whole
 * difference between an application window and a page — the frame is a constant
 * the user can rely on, so the harness can take the content area without taking
 * the controls or the readout with it. The first-run guide is inside that rule
 * too: it replaces the content area and nothing else, so setting the application
 * up happens in the application rather than in front of it.
 */
export default function App() {
  const status = useHarness((state) => state.status)
  const environment = useHarness((state) => state.environment)
  const inspect = useHarness((state) => state.inspect)
  const refreshRemote = useRemote((state) => state.refresh)
  const stage = useOnboarding((state) => state.stage)
  const consider = useOnboarding((state) => state.consider)
  const origin = status.phase === 'ready' ? status.origin : null

  // Which harness the user asked to look away from, rather than a bare boolean.
  // Tying the request to an origin means a newly started harness is shown
  // without an effect having to reach in and reset a flag — and a restart, which
  // lands on a fresh port, is a new origin and so gets the same treatment.
  const [panelFor, setPanelFor] = useState<string | null>(null)
  const [view, setView] = useState<View>('console')
  // Held by the window rather than by the title bar that opens it: the manager
  // covers the window, and a modal inside a strip 36px tall would be positioned
  // against a strip 36px tall.
  const [managing, setManaging] = useState(false)

  // Showing a pane always means putting it in front. Anything else answers a
  // keystroke by changing something the user cannot see.
  const show = useCallback(
    (next: View) => {
      setView(next)
      setPanelFor(origin)
    },
    [origin],
  )

  // The one look at the machine, owned here rather than by a pane, because two
  // things now depend on the answer: the console shows it, and the guide exists
  // or does not because of it. Settled on both paths — `inspect` is allowed to
  // reject, and a rejected probe still has to let the window open.
  useEffect(() => {
    const settle = () => consider(useHarness.getState().environment)
    void inspect().then(settle, settle)
  }, [inspect, consider])

  // The window was created hidden. Reveal it once there is something in it —
  // which now means after the probe has settled, so the first painted frame is
  // either the guide or the workspace and never one replaced by the other. Rust
  // shows the window on a deadline regardless, so a probe that never returns
  // costs a few seconds rather than a window that never appears.
  useEffect(() => {
    if (stage === 'unknown') return

    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void getCurrentWindow().show()
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [stage])

  useEffect(() => {
    const pending = subscribeToHarness()
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [])

  // Subscribed for the lifetime of the window, not from the pane that shows it:
  // the supervisor closes remote access when the harness stops, and the nav rail
  // has to stop claiming otherwise even while the user is looking elsewhere.
  useEffect(() => {
    void refreshRemote()
    const pending = subscribeToRemote()
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [refreshRemote])

  // Shells have to keep printing while the user is looking at something else,
  // and a shell that falls over has to be able to say so from a pane that is not
  // on screen. Subscribing from the window is also what lets the rail carry a
  // count of them, which is the reminder that they end with this window.
  useEffect(() => {
    const pending = subscribeToTerminals()
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [])

  // Also here rather than in the status bar that shows the result: the check
  // should keep its schedule while the user is reading a pane, and a component
  // that unmounts must not be able to take the schedule down with it.
  useEffect(() => watchForUpdates(), [])

  // Ctrl+1 through Ctrl+6, in rail order. Every application with a fixed set of
  // views has these, and a user who tries one and gets nothing has just learned
  // that this is not one of those applications.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      // A modal is a question, and the rest of the window is not answering it.
      if (managing || useDialog.getState().pending) return
      const wanted = VIEWS[Number(event.key) - 1]
      if (!wanted) return
      event.preventDefault()
      show(wanted.id)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [managing, show])

  // With nothing serving there is nothing else to show.
  const showPanel = origin === null || panelFor === origin

  return (
    // No ground of its own: the body is the window's ground, and where a
    // backdrop material is drawn behind it, a second fill here would cover it.
    <div className="flex h-full flex-col overflow-hidden">
      <TitleBar
        serving={origin !== null}
        panelOpen={showPanel}
        onTogglePanel={
          origin ? () => setPanelFor((current) => (current === origin ? null : origin)) : undefined
        }
        // Not while the guide is up: which profile to work in is a question for
        // somebody who already has a harness to point at one.
        onManageProfiles={stage === 'guiding' ? undefined : () => setManaging(true)}
      />

      {stage === 'guiding' ? (
        // Unmounted, not hidden. There is nothing behind the guide yet worth
        // preserving — no harness running, no search typed — and mounting the
        // workbench underneath it would start the panes off answering questions
        // about a machine the user is still setting up.
        <Onboarding />
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {origin && <HarnessFrame origin={origin} hidden={showPanel} />}
          {/* Hidden rather than unmounted, for the same reason the frame is: a
              search someone typed and a pairing code on screen must survive a
              glance at the harness. */}
          <Workbench hidden={!showPanel} view={view} onSelect={show} />
        </div>
      )}

      <StatusBar status={status} environment={environment} onOpenUpdate={() => show('about')} />

      {managing && <ProfileManager onClose={() => setManaging(false)} />}

      {/* Last, and outside the layout: these are positioned against the window
          and have to be able to cover anything in it. The dialog is mounted after
          the manager because the manager asks it questions, and the menu after
          the dialog because a right-click inside a dialog still gets a menu. */}
      <Dialog />
      <ContextMenu />
      <Tooltip />
    </div>
  )
}

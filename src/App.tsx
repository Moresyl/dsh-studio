import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

import { CommandPalette } from '@/components/CommandPalette'
import { ContextMenu } from '@/components/ContextMenu'
import { Dialog } from '@/components/Dialog'
import { HarnessFrame } from '@/components/HarnessFrame'
import { Onboarding } from '@/components/Onboarding'
import { RecoveryCenter } from '@/components/RecoveryCenter'
import { StatusBar } from '@/components/StatusBar'
import { TitleBar } from '@/components/TitleBar'
import { Tooltip } from '@/components/Tooltip'
import { SETTINGS, VIEWS, type View } from '@/components/workbench-contract'
import { t } from '@/lib/i18n'
import { pushWorkspaceDrop } from '@/lib/bridge'
import * as ipc from '@/lib/ipc'
import { standby } from '@/lib/platform'
import { useDialog } from '@/state/dialog'
import { subscribeToHarness, useHarness } from '@/state/harness'
import { useOnboarding } from '@/state/onboarding'
import { usePalette } from '@/state/palette'
import { usePresentation } from '@/state/presentation'
import { subscribeToProfiles } from '@/state/profiles'
import { subscribeToRemote, useRemote } from '@/state/remote'
import { useUpdate, watchForUpdates } from '@/state/update'
import { switchWorkspace } from '@/state/workspace'

const ProfileManager = lazy(() =>
  import('@/components/ProfileManager').then((module) => ({ default: module.ProfileManager })),
)
const Workbench = lazy(() =>
  import('@/components/Workbench').then((module) => ({ default: module.Workbench })),
)

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

  const presentation = usePresentation((state) => state.mode)
  const choosePresentation = usePresentation((state) => state.choose)
  // With nothing serving there is nothing else to show.
  const showPanel = origin === null || presentation === 'advanced'
  const [view, setView] = useState<View>('console')
  const [workbenchLoaded, setWorkbenchLoaded] = useState(presentation === 'advanced')
  // Held by the window rather than by the title bar that opens it: the manager
  // covers the window, and a modal inside a strip 36px tall would be positioned
  // against a strip 36px tall.
  const [managing, setManaging] = useState(false)

  // This effect can only run after React committed the application root. Rust
  // uses that fact to cancel the static startup-recovery deadline; it is not a
  // Harness health signal and deliberately does not wait for Node or a profile.
  useEffect(() => {
    void ipc.rendererReady().catch(() => {
      // A browser preview has no native recovery channel. The visible UI still
      // works, and Rust retains its deadline in a real desktop window.
    })
  }, [])

  // Stable, because the palette rebuilds its command list from its props and
  // this window re-renders on every line the harness prints.
  const manage = useCallback(() => setManaging(true), [])
  const chooseWorkspace = useCallback(async () => {
    const chosen = await openDialog({
      title: t('workspace.choose'),
      defaultPath: useHarness.getState().environment?.workspace,
      directory: true,
      multiple: false,
    })
    if (typeof chosen === 'string') await switchWorkspace(chosen)
  }, [])

  // Showing a pane always means putting it in front. Anything else answers a
  // keystroke by changing something the user cannot see.
  const show = useCallback(
    (next: View) => {
      setView(next)
      setWorkbenchLoaded(true)
      choosePresentation('advanced')
    },
    [choosePresentation],
  )
  const present = useCallback(
    (mode: 'compatibility' | 'extended' | 'advanced') => {
      if (mode === 'advanced') setWorkbenchLoaded(true)
      choosePresentation(mode)
    },
    [choosePresentation],
  )

  // The one look at the machine, owned here rather than by a pane, because two
  // things now depend on the answer: the console shows it, and the guide exists
  // or does not because of it. Settled on both paths — `inspect` records and
  // rejects a failed probe, and that failure still has to let the window open.
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
    // Except when the login item started this: nobody asked for a window, and
    // one appearing over their work at every boot is how a tray app becomes
    // something people uninstall. The tray icon and the global key are the two
    // ways back, and both are already up by now.
    if (standby || stage === 'unknown') return

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
    // Loading the event owner asynchronously also keeps xterm's emulator out
    // of the first-paint bundle. The import starts immediately, so shells still
    // have a window-lifetime listener before anybody can navigate to the pane.
    const pending = import('@/state/terminals').then((module) => module.subscribeToTerminals())
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [])

  // Windows are views onto one set of profiles, so a profile made, renamed or
  // switched to in another window is a change to this one. From the window and
  // not from the manager, because the chip in the title bar reads the same
  // roster and is never closed.
  useEffect(() => {
    const pending = subscribeToProfiles()
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [])

  // Also here rather than in the status bar that shows the result: the check
  // should keep its schedule while the user is reading a pane, and a component
  // that unmounts must not be able to take the schedule down with it.
  useEffect(() => watchForUpdates(), [])

  // macOS owns an application menu even when the custom title bar owns the
  // rest of the chrome. Its update item enters the same checked state as the
  // About pane button and brings that evidence into view.
  useEffect(() => {
    const pending = ipc.onApplicationCheckUpdate(() => {
      show('about')
      void useUpdate.getState().check(false)
    })
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [show])

  // A native drop belongs to the surface the user can see. In the Studio
  // workbench it changes the next Harness working directory; in compatibility
  // presentation it is handed to the upstream Workspace service so it creates
  // a real Workspace row and session there instead of changing an unrelated
  // shell setting.
  useEffect(() => {
    const pending = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop' || event.payload.paths.length !== 1) return
      const [path] = event.payload.paths
      if (!path) return
      if (!showPanel && origin) pushWorkspaceDrop(path, origin)
      else void switchWorkspace(path)
    })
    return () => {
      void pending.then((unlisten) => unlisten())
    }
  }, [origin, showPanel])

  // Ctrl+K, Ctrl+1 through Ctrl+6 in rail order, Ctrl+comma for settings, and
  // Ctrl+Shift+N for another window. Every application with a fixed set of views
  // has the numbers, and a user who tries one and gets nothing has just learned
  // that this is not one of those applications. The palette is the other half of
  // that: the keystroke for when someone knows the name of what they want and
  // not where it lives.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      // A modal is a question, and the rest of the window is not answering it.
      // Nor is the guide, which is the whole window until it is done with.
      if (managing || stage === 'guiding' || useDialog.getState().pending) return

      if (event.key === 'k' || event.key === 'K') {
        event.preventDefault()
        usePalette.getState().toggle()
        return
      }

      // The palette is a modal of the same kind, and the numbers behind it would
      // switch a pane nobody can see.
      if (usePalette.getState().open) return

      // The one shortcut here that carries Shift, and the reason nothing above
      // it may reach a shifted key: Ctrl+Shift+1 is not Ctrl+1.
      if (event.shiftKey) {
        if (event.key !== 'n' && event.key !== 'N') return
        event.preventDefault()
        // Held down, a key repeats — and this one asks for a whole webview every
        // time it does. The first press is the one somebody meant.
        if (!event.repeat) void ipc.windowOpen()
        return
      }

      // The keystroke every desktop application answers with its preferences,
      // and the reason settings is not the seventh number.
      if (event.key === ',') {
        event.preventDefault()
        show(SETTINGS.id)
        return
      }

      const wanted = VIEWS[Number(event.key) - 1]
      if (!wanted) return
      event.preventDefault()
      show(wanted.id)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [managing, stage, show])

  return (
    // No ground of its own: the body is the window's ground, and where a
    // backdrop material is drawn behind it, a second fill here would cover it.
    <div className="flex h-full flex-col overflow-hidden">
      <TitleBar
        serving={origin !== null}
        mode={presentation}
        onPresentation={origin ? present : undefined}
        // Not while the guide is up: which profile to work in is a question for
        // somebody who already has a harness to point at one.
        onManageProfiles={stage === 'guiding' ? undefined : manage}
      />

      {stage === 'guiding' ? (
        // Unmounted, not hidden. There is nothing behind the guide yet worth
        // preserving — no harness running, no search typed — and mounting the
        // workbench underneath it would start the panes off answering questions
        // about a machine the user is still setting up.
        <Onboarding />
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {origin && (
            <div className="flex min-h-0 flex-1 flex-col" hidden={showPanel}>
              {presentation === 'extended' && (
                <ExtendedToolbar
                  onView={show}
                  onProfiles={manage}
                  onWorkspace={() => void chooseWorkspace()}
                />
              )}
              <div className="relative min-h-0 flex-1">
                <HarnessFrame origin={origin} hidden={false} />
              </div>
            </div>
          )}
          {/* Hidden rather than unmounted, for the same reason the frame is: a
              search someone typed and a pairing code on screen must survive a
              glance at the harness. */}
          {workbenchLoaded && (
            <Suspense fallback={<LoadingSurface />}>
              <Workbench hidden={!showPanel} view={view} onSelect={show} />
            </Suspense>
          )}
        </div>
      )}

      <StatusBar
        status={status}
        environment={environment}
        onOpenUpdate={() => show('about')}
        onChangeWorkspace={() => void chooseWorkspace()}
      />

      {managing && (
        <Suspense fallback={<LoadingSurface overlay />}>
          <ProfileManager onClose={() => setManaging(false)} />
        </Suspense>
      )}
      <RecoveryCenter />

      {/* Not while the guide is up, for the same reason the manager is not
          reachable from the title bar there: every command it offers is about a
          workspace the user is still assembling. */}
      {stage !== 'guiding' && <CommandPalette onView={show} onManageProfiles={manage} />}

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

function ExtendedToolbar({
  onView,
  onProfiles,
  onWorkspace,
}: {
  onView: (view: View) => void
  onProfiles: () => void
  onWorkspace: () => void
}) {
  return (
    <nav
      aria-label={t('extended.actions')}
      className="chrome flex h-10 shrink-0 items-center gap-1 border-b border-line px-3"
    >
      <span className="mr-2 text-[11.5px] font-medium text-faint">{t('extended.label')}</span>
      <ToolbarButton onClick={() => onView('terminal')}>{t('nav.terminal')}</ToolbarButton>
      <ToolbarButton onClick={() => onView('sessions')}>{t('nav.sessions')}</ToolbarButton>
      <ToolbarButton onClick={() => onView('plugins')}>{t('nav.plugins')}</ToolbarButton>
      <ToolbarButton onClick={onProfiles}>{t('profile.manage')}</ToolbarButton>
      <ToolbarButton onClick={onWorkspace}>{t('workspace.choose')}</ToolbarButton>
    </nav>
  )
}

function ToolbarButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-control px-2.5 text-[11.5px] text-muted transition-colors hover:bg-surface-2 hover:text-text"
    >
      {children}
    </button>
  )
}

function LoadingSurface({ overlay = false }: { overlay?: boolean }) {
  return (
    <div
      role="status"
      className={[
        'grid place-items-center bg-canvas text-[12px] text-faint',
        overlay ? 'absolute inset-0 z-50' : 'min-h-0 flex-1',
      ].join(' ')}
    >
      {t('common.loading')}
    </div>
  )
}

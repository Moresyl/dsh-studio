import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  LayoutDashboard,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
} from 'lucide-react'

import { Badge } from '@/components/Badge'
import { BrandMark } from '@/components/BrandMark'
import { IconButton } from '@/components/IconButton'
import { Segmented } from '@/components/Segmented'
import { ThemeSwitch } from '@/components/ThemeSwitch'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { ownAsync } from '@/lib/lifecycle'
import { drawsWindowControls, isMac } from '@/lib/platform'
import { contextMenu, SEPARATOR } from '@/state/menu'
import { reportAction, reportFailure } from '@/state/failure'
import type { Presentation } from '@/state/presentation'

/** Width the macOS traffic lights need before the title may start. */
const TRAFFIC_LIGHT_INSET = 78

interface TitleBarProps {
  /** Whether the harness is serving, and so presentation choices are available. */
  serving: boolean
  mode: Presentation
  sidebarCollapsed: boolean
  /** Current content identity, kept visible while the page scrolls. */
  pageTitle: string
  /** Broader workspace name, when it adds context rather than repeating the title. */
  sectionTitle?: string
  onToggleSidebar?: () => void
  /** Switch presentations. Absent while there is only one surface to show. */
  onPresentation?: (mode: Presentation) => void
}

/**
 * The strip the window is dragged by.
 *
 * On Windows and Linux it carries the window buttons, because the system title
 * bar is turned off. On macOS it only leaves room for the traffic lights the
 * system still draws.
 *
 * It also carries the view switch, because once the harness fills the window
 * this is the only chrome left and starting the harness would otherwise be a
 * one-way door. A switch and not a badge: the available presentations belong
 * on screen together with the current one marked. The
 * The profile switch lives in the workbench sidebar; Harness has its own
 * sidebar and should not get a second navigation column.
 */
export function TitleBar({
  serving,
  mode,
  sidebarCollapsed,
  pageTitle,
  sectionTitle,
  onToggleSidebar,
  onPresentation,
}: TitleBarProps) {
  const appWindow = getCurrentWindow()
  const [maximized, setMaximized] = useState(false)

  // Which window this is, or nothing at all in the first one — read off the
  // label rather than asked for over IPC, because it is fixed for the life of
  // the window and a title bar that numbered itself a frame late would be seen
  // doing it. See `label` in `src-tauri/src/window.rs`, which makes the label.
  const ordinal = /^work-(\d+)$/.exec(appWindow.label)?.[1]

  // Only the first window is put away instead of closed, so only the first one
  // may say so — see `hide_instead_of_quitting` in `src-tauri/src/tray.rs`,
  // which is attached to that window alone.
  const closeLabel = serving && !ordinal ? t('window.hide') : t('window.close')

  useEffect(() => {
    if (!drawsWindowControls) return

    let cancelled = false
    const sync = async () => {
      const next = await appWindow.isMaximized()
      if (!cancelled) setMaximized(next)
    }

    void sync().catch(() => {
      // Window controls still work with the conservative restored icon when a
      // transient native state read is unavailable.
    })
    const release = ownAsync(
      appWindow.onResized(() => {
        void sync().catch(() => {})
      }),
      reportFailure,
    )
    return () => {
      cancelled = true
      release()
    }
  }, [appWindow])

  // The menu a title bar answers a right-click with. Turning the decorations
  // off took the system's own away, and a title bar that does nothing when
  // right-clicked is one of the small absences that add up to "this is a web
  // page in a frame". Only where this app draws the chrome: macOS keeps its own
  // title bar, and has no window menu to imitate.
  const windowMenu = contextMenu(() => [
    // Above the strip's own commands and set apart from them, because it is the
    // one entry here that makes a window rather than changing this one. The
    // system's window menu has no equivalent to imitate, and this is the only
    // place a second window is reachable without knowing it exists.
    { label: t('window.new'), run: () => void reportAction(ipc.windowOpen) },
    SEPARATOR,
    {
      label: t('window.minimize'),
      run: () => void reportAction(() => appWindow.minimize()),
    },
    {
      label: maximized ? t('window.restore') : t('window.maximize'),
      run: () => void reportAction(() => appWindow.toggleMaximize()),
    },
    SEPARATOR,
    { label: closeLabel, run: () => void reportAction(() => appWindow.close()) },
  ])

  return (
    <header
      data-tauri-drag-region
      onContextMenu={drawsWindowControls ? windowMenu : undefined}
      className="relative flex h-9 shrink-0 items-center border-b border-line bg-canvas select-none"
      style={isMac ? { paddingLeft: TRAFFIC_LIGHT_INSET } : undefined}
    >
      <div
        data-tauri-drag-region
        className={[
          'chrome flex shrink-0 items-center gap-2 self-stretch border-r border-line bg-surface px-3 transition-[width] duration-150',
          sidebarCollapsed ? 'w-[52px] justify-center px-2' : 'w-[264px]',
        ].join(' ')}
      >
        {(!sidebarCollapsed || !onToggleSidebar) && (
          <BrandMark size={20} className="shrink-0 rounded-md" />
        )}
        {!sidebarCollapsed && (
          <span className="min-w-0 flex-1 truncate text-ui-base font-semibold text-text">
            DSH Studio
          </span>
        )}

        {/* Windows opened for a task look alike, and the number is what makes
            them referable — the same one the system title carries, so the
            taskbar and the strip agree about which window this is. */}
        {ordinal && !sidebarCollapsed && (
          <Badge data-hint={t('window.ordinal', { name: ordinal })} className="tabular-nums">
            {ordinal}
          </Badge>
        )}

        {onToggleSidebar && (
          <IconButton
            size="xs"
            label={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
            onClick={onToggleSidebar}
            className="ml-auto"
          />
        )}
      </div>

      <div
        data-tauri-drag-region
        className="relative flex min-w-0 flex-1 items-center self-stretch"
      >
        <div
          data-tauri-drag-region
          className="flex w-[calc(50%_-_160px)] min-w-0 items-baseline gap-2 pl-4 max-[1100px]:hidden"
        >
          <span className="max-w-full shrink-0 truncate text-ui-base font-semibold text-text">
            {pageTitle}
          </span>
          {sectionTitle && (
            <span className="truncate text-ui-xs text-faint before:mr-2 before:content-['·'] max-[1280px]:hidden">
              {sectionTitle}
            </span>
          )}
        </div>

        <div data-tauri-drag-region className="min-w-3 flex-1 self-stretch" />

        {serving && onPresentation && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto">
              <ViewSwitch mode={mode} onChoose={onPresentation} />
            </div>
          </div>
        )}
      </div>

      {/* Beside the window buttons rather than inside a pane, because the theme
          is a property of the window: the panes can all be behind the harness,
          and this strip is the one piece of chrome that is always on screen. */}
      <div className={drawsWindowControls ? 'pr-2' : 'px-2'}>
        <ThemeSwitch />
      </div>

      {drawsWindowControls && (
        // Window controls must remain reachable above errors and recovery
        // dialogs. Keep the header out of a stacking context so only these
        // controls, rather than workspace navigation, rise above the backdrop.
        <div
          data-window-controls
          className="relative z-60 flex items-stretch self-stretch bg-canvas"
        >
          <ControlButton
            label={t('window.minimize')}
            onClick={() => void reportAction(() => appWindow.minimize())}
          >
            <line x1="1" y1="5.5" x2="10" y2="5.5" />
          </ControlButton>

          <ControlButton
            label={maximized ? t('window.restore') : t('window.maximize')}
            onClick={() => void reportAction(() => appWindow.toggleMaximize())}
          >
            {maximized ? (
              <>
                <rect x="1.5" y="3" width="6.5" height="6.5" rx="1" />
                <path d="M3.5 3V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1" />
              </>
            ) : (
              <rect x="1.5" y="1.5" width="8" height="8" rx="1" />
            )}
          </ControlButton>

          {/* While the harness is up the shell hides instead of quitting, so the
              tooltip has to say so — a window that vanishes while a service it
              started stays alive is exactly the surprise worth avoiding. */}
          <ControlButton
            label={closeLabel}
            danger
            onClick={() => void reportAction(() => appWindow.close())}
          >
            <path d="M1.5 1.5 9.5 9.5M9.5 1.5 1.5 9.5" />
          </ControlButton>
        </div>
      )}
    </header>
  )
}

/**
 * Two views, both named, with the current one raised.
 *
 * Icon and label while the strip has room, the icon alone when it does not:
 * this is the one piece of chrome that has to give when the window narrows.
 */
function ViewSwitch({
  mode,
  onChoose,
}: {
  mode: Presentation
  onChoose: (mode: Presentation) => void
}) {
  return (
    <Segmented
      size="sm"
      responsive
      label={t('view.label')}
      value={mode}
      onChange={onChoose}
      items={[
        { value: 'compatibility', label: t('view.harness'), icon: MessageSquare },
        { value: 'extended', label: t('view.extended'), icon: PanelsTopLeft },
        { value: 'advanced', label: t('view.panel'), icon: LayoutDashboard },
      ]}
    />
  )
}

interface ControlButtonProps {
  label: string
  danger?: boolean
  onClick: () => void
  children: ReactNode
}

function ControlButton({ label, danger, onClick, children }: ControlButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      data-hint={label}
      onClick={onClick}
      className={[
        // Arrow, not a hand: the buttons the system would normally draw here
        // keep the system's cursor, and both Windows and macOS leave it alone
        // over their own window controls.
        'grid w-[46px] cursor-default place-items-center text-muted transition-colors duration-100',
        danger
          ? 'hover:bg-danger hover:text-white'
          : 'hover:bg-[color-mix(in_oklab,var(--color-text)_10%,transparent)] hover:text-text',
      ].join(' ')}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 11 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  )
}

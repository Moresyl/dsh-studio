import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { BrandMark } from '@/components/BrandMark'
import { t } from '@/lib/i18n'
import { drawsWindowControls, isMac } from '@/lib/platform'
import { contextMenu, SEPARATOR } from '@/state/menu'

/** Width the macOS traffic lights need before the title may start. */
const TRAFFIC_LIGHT_INSET = 78

interface TitleBarProps {
  /** Whether the harness is serving, and so whether there are two views. */
  serving: boolean
  /** Whether the control panel is the view currently in front. */
  panelOpen: boolean
  /** Switch views. Absent while there is only one view to show. */
  onTogglePanel?: () => void
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
 * one-way door. A switch and not a badge: it is the same two views every time,
 * so the pair belongs on screen together with the current one marked.
 */
export function TitleBar({ serving, panelOpen, onTogglePanel }: TitleBarProps) {
  const appWindow = getCurrentWindow()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!drawsWindowControls) return

    let cancelled = false
    const sync = async () => {
      const next = await appWindow.isMaximized()
      if (!cancelled) setMaximized(next)
    }

    void sync()
    const pending = appWindow.onResized(() => void sync())
    return () => {
      cancelled = true
      void pending.then((unlisten) => unlisten())
    }
  }, [appWindow])

  // The menu a title bar answers a right-click with. Turning the decorations
  // off took the system's own away, and a title bar that does nothing when
  // right-clicked is one of the small absences that add up to "this is a web
  // page in a frame". Only where this app draws the chrome: macOS keeps its own
  // title bar, and has no window menu to imitate.
  const windowMenu = contextMenu(() => [
    { label: t('window.minimize'), run: () => void appWindow.minimize() },
    {
      label: maximized ? t('window.restore') : t('window.maximize'),
      run: () => void appWindow.toggleMaximize(),
    },
    SEPARATOR,
    { label: serving ? t('window.hide') : t('window.close'), run: () => void appWindow.close() },
  ])

  return (
    <header
      data-tauri-drag-region
      onContextMenu={drawsWindowControls ? windowMenu : undefined}
      className="chrome relative z-20 flex h-9 shrink-0 items-center border-b border-line select-none"
      style={isMac ? { paddingLeft: TRAFFIC_LIGHT_INSET } : undefined}
    >
      <div data-tauri-drag-region className="flex flex-1 items-center gap-2 self-stretch pl-2.5">
        <BrandMark size={15} className="rounded-[4px]" />
        <span className="text-[12px] font-medium text-muted">DSH Studio</span>

        {serving && onTogglePanel && <ViewSwitch panelOpen={panelOpen} onToggle={onTogglePanel} />}
      </div>

      {drawsWindowControls && (
        <div className="flex items-stretch self-stretch">
          <ControlButton label={t('window.minimize')} onClick={() => void appWindow.minimize()}>
            <line x1="1" y1="5.5" x2="10" y2="5.5" />
          </ControlButton>

          <ControlButton
            label={maximized ? t('window.restore') : t('window.maximize')}
            onClick={() => void appWindow.toggleMaximize()}
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
            label={serving ? t('window.hide') : t('window.close')}
            danger
            onClick={() => void appWindow.close()}
          >
            <path d="M1.5 1.5 9.5 9.5M9.5 1.5 1.5 9.5" />
          </ControlButton>
        </div>
      )}
    </header>
  )
}

/** Two views, both named, with the current one raised. */
function ViewSwitch({ panelOpen, onToggle }: { panelOpen: boolean; onToggle: () => void }) {
  return (
    <div className="ml-2 flex items-center gap-0.5 rounded-control bg-canvas-deep p-0.5 hairline">
      <SwitchTab label={t('view.harness')} active={!panelOpen} onClick={onToggle} />
      <SwitchTab label={t('view.panel')} active={panelOpen} onClick={onToggle} />
    </div>
  )
}

interface SwitchTabProps {
  label: string
  active: boolean
  onClick: () => void
}

function SwitchTab({ label, active, onClick }: SwitchTabProps) {
  return (
    <button
      type="button"
      // The pair is one control, so the pressed one is the state of the whole
      // rather than two buttons that happen to look related.
      aria-pressed={active}
      onClick={active ? undefined : onClick}
      className={[
        'h-[20px] rounded-[3px] px-2 text-[11.5px] transition-colors duration-100',
        active ? 'bg-surface-2 text-text shadow-panel' : 'text-faint hover:text-muted',
      ].join(' ')}
    >
      {label}
    </button>
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
      title={label}
      onClick={onClick}
      className={[
        'grid w-[46px] place-items-center text-muted transition-colors duration-100',
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

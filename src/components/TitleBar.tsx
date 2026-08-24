import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { BrandMark } from '@/components/BrandMark'
import { ProfileSwitch } from '@/components/ProfileSwitch'
import { ThemeSwitch } from '@/components/ThemeSwitch'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { drawsWindowControls, isMac } from '@/lib/platform'
import { contextMenu, SEPARATOR } from '@/state/menu'
import type { Presentation } from '@/state/presentation'

/** Width the macOS traffic lights need before the title may start. */
const TRAFFIC_LIGHT_INSET = 78

interface TitleBarProps {
  /** Whether the harness is serving, and so presentation choices are available. */
  serving: boolean
  mode: Presentation
  /** Switch presentations. Absent while there is only one surface to show. */
  onPresentation?: (mode: Presentation) => void
  /** Open the profile manager. Absent while the first-run guide is up. */
  onManageProfiles?: () => void
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
 * profile chip is here for the same reason: which stack is running is a property
 * of the window, and this strip is what survives the harness taking the rest.
 */
export function TitleBar({ serving, mode, onPresentation, onManageProfiles }: TitleBarProps) {
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
    // Above the strip's own commands and set apart from them, because it is the
    // one entry here that makes a window rather than changing this one. The
    // system's window menu has no equivalent to imitate, and this is the only
    // place a second window is reachable without knowing it exists.
    { label: t('window.new'), run: () => void ipc.windowOpen() },
    SEPARATOR,
    { label: t('window.minimize'), run: () => void appWindow.minimize() },
    {
      label: maximized ? t('window.restore') : t('window.maximize'),
      run: () => void appWindow.toggleMaximize(),
    },
    SEPARATOR,
    { label: closeLabel, run: () => void appWindow.close() },
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

        {/* Windows opened for a task look alike, and the number is what makes
            them referable — the same one the system title carries, so the
            taskbar and the strip agree about which window this is. */}
        {ordinal && (
          <span
            data-hint={t('window.ordinal', { name: ordinal })}
            className="grid h-[15px] min-w-[15px] shrink-0 place-items-center rounded-[4px] border border-line px-1 text-[10px] text-faint tabular-nums"
          >
            {ordinal}
          </span>
        )}

        {serving && onPresentation && <ViewSwitch mode={mode} onChoose={onPresentation} />}

        {onManageProfiles && <ProfileSwitch onManage={onManageProfiles} />}
      </div>

      {/* Beside the window buttons rather than inside a pane, because the theme
          is a property of the window: the panes can all be behind the harness,
          and this strip is the one piece of chrome that is always on screen. */}
      <div className={drawsWindowControls ? 'pr-2' : 'px-2'}>
        <ThemeSwitch />
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
          <ControlButton label={closeLabel} danger onClick={() => void appWindow.close()}>
            <path d="M1.5 1.5 9.5 9.5M9.5 1.5 1.5 9.5" />
          </ControlButton>
        </div>
      )}
    </header>
  )
}

/** Two views, both named, with the current one raised. */
function ViewSwitch({
  mode,
  onChoose,
}: {
  mode: Presentation
  onChoose: (mode: Presentation) => void
}) {
  return (
    <div className="ml-2 flex items-center gap-0.5 rounded-control bg-canvas-deep p-0.5 hairline">
      <SwitchTab
        label={t('view.harness')}
        active={mode === 'compatibility'}
        onClick={() => onChoose('compatibility')}
      />
      <SwitchTab
        label={t('view.extended')}
        active={mode === 'extended'}
        onClick={() => onChoose('extended')}
      />
      <SwitchTab
        label={t('view.panel')}
        active={mode === 'advanced'}
        onClick={() => onChoose('advanced')}
      />
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
        // The raised half of the pair does nothing when pressed, so it does not
        // offer the hand that promises it would.
        active
          ? 'cursor-default bg-surface-2 text-text shadow-panel'
          : 'text-faint hover:bg-surface-2/60 hover:text-text',
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

import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'

import { BrandMark } from '@/components/BrandMark'
import { t } from '@/lib/i18n'
import { drawsWindowControls, isMac } from '@/lib/platform'

/** Width the macOS traffic lights need before the title may start. */
const TRAFFIC_LIGHT_INSET = 78

interface TitleBarProps {
  /** Origin the harness is serving on, or `null` when it is not running. */
  origin?: string | null
  /** Whether the control panel is the layer currently in front. */
  panelOpen?: boolean
  /** Switch layers. Absent while there is only one layer to show. */
  onTogglePanel?: () => void
}

/**
 * The strip the window is dragged by.
 *
 * On Windows and Linux it carries the window buttons, because the system title
 * bar is turned off. On macOS it only leaves room for the traffic lights the
 * system still draws.
 *
 * Once the harness fills the window this is the only chrome left, so it also
 * carries the way back to the control panel — otherwise starting the harness
 * would be a one-way door.
 */
export function TitleBar({ origin, panelOpen, onTogglePanel }: TitleBarProps) {
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

  // The harness draws its own flat dark surface right up to our strip. A hairline
  // and a deeper ground keep that meeting point deliberate instead of accidental.
  const overContent = origin != null && panelOpen === false

  return (
    <header
      data-tauri-drag-region
      className={[
        'relative z-20 flex h-10 shrink-0 items-center pr-0 select-none',
        overContent ? 'border-b border-line bg-canvas-deep' : '',
      ].join(' ')}
      style={isMac ? { paddingLeft: TRAFFIC_LIGHT_INSET } : undefined}
    >
      <div
        data-tauri-drag-region
        className="flex flex-1 items-center gap-2 self-stretch pl-3"
      >
        <BrandMark size={16} className="rounded-[4px] opacity-90" />
        <span className="text-[12px] font-medium tracking-wide text-muted">DSH Studio</span>

        {origin && onTogglePanel && (
          <ServiceChip origin={origin} panelOpen={panelOpen === true} onClick={onTogglePanel} />
        )}
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

          <ControlButton
            label={t('window.close')}
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

interface ServiceChipProps {
  origin: string
  panelOpen: boolean
  onClick: () => void
}

/**
 * Live service indicator, and the door back to the control panel.
 *
 * It reports the port rather than a generic "connected", because the port is
 * the thing someone actually needs when they want to reach the service from a
 * terminal or another browser.
 */
function ServiceChip({ origin, panelOpen, onClick }: ServiceChipProps) {
  const label = panelOpen ? t('chip.backToHarness') : t('chip.openPanel')

  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} · ${origin}`}
      aria-label={label}
      className="ml-1 flex items-center gap-1.5 rounded-full border border-line px-2 py-[3px] text-[11px] text-muted transition-colors duration-150 hover:border-line-strong hover:text-text"
    >
      <span className="size-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--color-ok)]" />
      <span className="font-mono tabular-nums">{portOf(origin)}</span>
    </button>
  )
}

/** `http://127.0.0.1:62943` → `:62943`, which is the part that varies. */
const portOf = (origin: string): string => {
  const port = origin.slice(origin.lastIndexOf(':'))
  return port.startsWith(':') ? port : origin
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

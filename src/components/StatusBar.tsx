import { useState, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'

import { StatusDot } from '@/components/StatusDot'
import { t } from '@/lib/i18n'
import { formatVersion, type Environment, type Status } from '@/lib/ipc'
import { labelOf, toneOf } from '@/lib/status'

/**
 * The strip along the bottom of the window.
 *
 * Everything on it is a readout that stays true for as long as the app is open:
 * what the harness is doing, where it is serving, what it is running on. That is
 * what a status bar is for, and it is why the address moved here out of the
 * title bar — a live figure belongs in the place a user learns to glance at,
 * not in a badge floating next to the application name.
 *
 * Nothing here is the only way to do anything. Every segment is a shortcut to
 * something the panel also offers.
 */
interface StatusBarProps {
  status: Status
  environment: Environment | null
}

export function StatusBar({ status, environment }: StatusBarProps) {
  const origin = status.phase === 'ready' ? status.origin : null
  const node = environment?.node ?? null

  return (
    <footer className="chrome relative z-20 flex h-[26px] shrink-0 items-stretch border-t border-line text-[11px] text-muted select-none">
      <Segment title={labelOf(status)}>
        <StatusDot tone={toneOf(status)} size={7} />
        {labelOf(status)}
      </Segment>

      {origin && <AddressSegment origin={origin} />}

      <div className="flex-1" />

      {node && (
        <Segment title={node.path}>
          Node {formatVersion(node.version)}
          <span className="text-faint">· {t(`source.${node.source}`)}</span>
        </Segment>
      )}

      {environment && (
        // The workspace is where the agent's files land, so the segment that
        // names it is also the way to go and look at them.
        <Segment
          title={`${environment.workspace}\n${t('statusbar.reveal')}`}
          onClick={() => void revealItemInDir(environment.workspace)}
        >
          <FolderOpen size={11} strokeWidth={2} className="shrink-0 text-faint" />
          <span className="max-w-[22rem] truncate">{tail(environment.workspace)}</span>
        </Segment>
      )}
    </footer>
  )
}

/**
 * The address, with the two things anyone ever wants to do with one.
 *
 * A click opens it in the user's own browser — the harness is a web service and
 * sometimes the right window for it is not this one. A right-click copies it,
 * because the other half of the time it is being pasted into a terminal.
 */
function AddressSegment({ origin }: { origin: string }) {
  const [copied, setCopied] = useState(false)

  // The webview's own clipboard rather than a plugin: this runs on localhost,
  // which is a secure context on every platform we ship, and a click is the
  // user gesture the API asks for.
  const copy = () => {
    void navigator.clipboard.writeText(origin).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <Segment
      title={`${t('statusbar.open')} · ${t('statusbar.copy')}`}
      onClick={() => void openUrl(origin)}
      onContextMenu={copy}
    >
      <span className="font-mono tabular-nums">
        {copied ? t('statusbar.copied') : origin.replace(/^https?:\/\//, '')}
      </span>
    </Segment>
  )
}

interface SegmentProps {
  title: string
  onClick?: () => void
  onContextMenu?: () => void
  children: ReactNode
}

function Segment({ title, onClick, onContextMenu, children }: SegmentProps) {
  const className = 'flex items-center gap-1.5 px-2.5 whitespace-nowrap'

  if (!onClick) {
    return (
      <div className={className} title={title}>
        {children}
      </div>
    )
  }

  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu?.()
      }}
      className={`${className} transition-colors duration-100 hover:bg-surface-2 hover:text-text`}
    >
      {children}
    </button>
  )
}

/** Keep the end of a path, which is the part that identifies it. */
const tail = (path: string, segments = 2): string => {
  const separator = path.includes('\\') ? '\\' : '/'
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segments) return path
  return `…${separator}${parts.slice(-segments).join(separator)}`
}

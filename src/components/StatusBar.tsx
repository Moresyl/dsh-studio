import type { MouseEvent, ReactNode } from 'react'
import { ArrowUpCircle, Copy, FolderOpen, FolderSearch2, X } from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import { StatusDot } from '@/components/StatusDot'
import { t } from '@/lib/i18n'
import { formatVersion, type Environment, type Status } from '@/lib/ipc'
import { labelOf, toneOf } from '@/lib/status'
import { contextMenu } from '@/state/menu'
import { isAnnounceable, useUpdate } from '@/state/update'

/**
 * The strip along the bottom of the window.
 *
 * Everything on it is a readout that stays true for as long as the app is open:
 * what the harness is doing, what it is running on, and where its files land.
 *
 * The one thing deliberately absent is the service address. A desktop
 * application that prints `127.0.0.1:52418` along its bottom edge is telling on
 * itself — it says the window is a browser wearing a coat, and it hands the user
 * a number they have no use for. The address is a fact about the plumbing, so it
 * lives in the control panel with the rest of the plumbing.
 *
 * Nothing here is the only way to do anything. Every segment is a shortcut to
 * something the panel also offers.
 */
interface StatusBarProps {
  status: Status
  environment: Environment | null
  onOpenUpdate: () => void
  onChangeWorkspace: () => void
}

export function StatusBar({
  status,
  environment,
  onOpenUpdate,
  onChangeWorkspace,
}: StatusBarProps) {
  const node = environment?.node ?? null

  return (
    <footer className="chrome relative z-20 flex h-[26px] shrink-0 items-stretch border-t border-line text-[11px] text-muted select-none">
      <Segment hint={labelOf(status)}>
        <StatusDot tone={toneOf(status)} size={7} />
        {labelOf(status)}
      </Segment>

      <UpdateNotice onOpen={onOpenUpdate} />

      <div className="flex-1" />

      {node && (
        <Segment
          hint={node.path}
          onContextMenu={contextMenu([
            {
              label: t('menu.copyPath'),
              icon: Copy,
              run: () => void navigator.clipboard.writeText(node.path),
            },
            {
              label: t('statusbar.reveal'),
              icon: FolderOpen,
              run: () => void revealItemInDir(node.path),
            },
          ])}
        >
          Node {formatVersion(node.version)}
          <span className="text-faint">· {t(`source.${node.source}`)}</span>
        </Segment>
      )}

      {environment && (
        // The workspace is where the agent's files land, so the segment that
        // names it is also the way to go and look at them.
        <Segment
          hint={`${environment.workspace}\n${t('workspace.choose')}`}
          onClick={onChangeWorkspace}
          onContextMenu={contextMenu([
            {
              label: t('workspace.choose'),
              icon: FolderSearch2,
              run: onChangeWorkspace,
            },
            {
              label: t('statusbar.reveal'),
              icon: FolderOpen,
              run: () => void revealItemInDir(environment.workspace),
            },
            {
              label: t('menu.copyPath'),
              icon: Copy,
              run: () => void navigator.clipboard.writeText(environment.workspace),
            },
          ])}
        >
          <FolderOpen size={11} strokeWidth={2} className="shrink-0 text-faint" />
          <span className="max-w-[22rem] truncate">{tail(environment.workspace)}</span>
        </Segment>
      )}
    </footer>
  )
}

/**
 * A new version, said once and quietly.
 *
 * The status bar is the right place for this and a modal is the wrong one: an
 * update is news, not an interruption, and the corner of the window is where a
 * desktop application has always been allowed to mention news. It reads as a
 * link because it is one — the click opens About, where the release notes and
 * signed installer are both available. Installation still begins only after a
 * second, explicit click.
 *
 * The dismiss button is the point of the whole design. Without it this is an
 * advertisement that reappears every launch; with it, the answer is remembered
 * and the notice stays gone until there is genuinely something else to say.
 */
function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const release = useUpdate((state) => state.release)
  const announce = useUpdate(isAnnounceable)
  const dismiss = useUpdate((state) => state.dismiss)

  if (!announce || !release) return null

  return (
    <div className="flex items-center self-center ml-1.5 animate-rise">
      <button
        type="button"
        data-hint={t('update.view')}
        onClick={onOpen}
        className="flex h-[19px] items-center gap-1.5 rounded-l-control bg-brand/12 pr-1.5 pl-2 text-brand transition-colors duration-100 hover:bg-brand/20"
      >
        <ArrowUpCircle size={12} strokeWidth={2.2} className="shrink-0" aria-hidden="true" />
        <span className="whitespace-nowrap">
          {t('update.available', { version: release.version })}
        </span>
      </button>

      <button
        type="button"
        data-hint={t('update.dismiss')}
        aria-label={t('update.dismiss')}
        onClick={dismiss}
        className="flex h-[19px] w-[19px] items-center justify-center rounded-r-control bg-brand/12 text-brand/70 transition-colors duration-100 hover:bg-brand/20 hover:text-brand"
      >
        <X size={11} strokeWidth={2.4} aria-hidden="true" />
      </button>
    </div>
  )
}

interface SegmentProps {
  /** What the segment says when it is pointed at — often the full path. */
  hint: string
  onClick?: () => void
  onContextMenu?: (event: MouseEvent) => void
  children: ReactNode
}

function Segment({ hint, onClick, onContextMenu, children }: SegmentProps) {
  const className = 'flex items-center gap-1.5 px-2.5 whitespace-nowrap'

  if (!onClick) {
    return (
      <div className={className} data-hint={hint} onContextMenu={onContextMenu}>
        {children}
      </div>
    )
  }

  return (
    <button
      type="button"
      data-hint={hint}
      // The visible label is shortened to fit the strip, so the full one has to
      // reach a reader some other way than by being drawn.
      aria-label={hint}
      onClick={onClick}
      onContextMenu={onContextMenu}
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

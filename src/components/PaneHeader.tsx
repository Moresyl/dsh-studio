import type { ReactNode } from 'react'

interface PaneHeaderProps {
  title: string
  /** One line saying what this pane acts on. Optional, never a second sentence. */
  subtitle?: string
  /** Full text when the subtitle is a path that had to be shortened. */
  subtitleHint?: string
  /** The pane's own controls, right-aligned. */
  children?: ReactNode
  /** Reading panes stay narrow; data-heavy workspaces use the wider measure. */
  width?: 'narrow' | 'wide'
}

/**
 * The strip every pane but the console wears.
 *
 * A pane in a desktop tool says what it is and offers its one primary action in
 * the same place each time; that constancy is what lets someone switch views
 * without re-reading the window. The console is the exception on purpose — its
 * rail already names the app and reports the service, and a second title above
 * that would be a title about a title.
 */
export function PaneHeader({
  title,
  subtitle,
  subtitleHint,
  children,
  width = 'wide',
}: PaneHeaderProps) {
  return (
    <header className="pane-header shrink-0 bg-canvas px-6 pt-6 pb-4">
      <div
        className={[
          'mx-auto flex min-h-12 w-full min-w-0 items-center gap-5',
          width === 'narrow' ? 'max-w-[780px]' : 'max-w-[1040px]',
        ].join(' ')}
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-[20px] leading-tight font-semibold text-text">{title}</h2>
          {subtitle && (
            <p
              className="mt-1.5 truncate text-[12.5px] leading-relaxed text-muted"
              data-hint={subtitleHint}
            >
              {subtitle}
            </p>
          )}
        </div>

        {children && (
          <div className="pane-header-actions ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            {children}
          </div>
        )}
      </div>
    </header>
  )
}

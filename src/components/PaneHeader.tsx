import type { ReactNode } from 'react'

interface PaneHeaderProps {
  title: string
  /** One line saying what this pane acts on. Optional, never a second sentence. */
  subtitle?: string
  /** Full text when the subtitle is a path that had to be shortened. */
  subtitleHint?: string
  /** The pane's own controls, right-aligned. */
  children?: ReactNode
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
export function PaneHeader({ title, subtitle, subtitleHint, children }: PaneHeaderProps) {
  return (
    <header className="chrome flex h-14 shrink-0 items-center gap-4 border-b border-line px-5">
      <div className="min-w-0">
        <h2 className="text-[13.5px] leading-none font-semibold tracking-[-0.01em] text-text">
          {title}
        </h2>
        {subtitle && (
          <p
            className="mt-1.5 truncate text-[11.5px] leading-none text-faint"
            data-hint={subtitleHint}
          >
            {subtitle}
          </p>
        )}
      </div>

      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  )
}

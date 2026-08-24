import { useEffect, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { AboutPane } from '@/components/AboutPane'
import { ConsolePane } from '@/components/ConsolePane'
import { PluginMarket } from '@/components/PluginMarket'
import { RemotePane } from '@/components/RemotePane'
import { SessionsPane } from '@/components/SessionsPane'
import { SettingsPane } from '@/components/SettingsPane'
import { TerminalPane } from '@/components/TerminalPane'
import { t } from '@/lib/i18n'
import { ACCELERATOR } from '@/lib/platform'
import { SETTINGS, SETTINGS_KEYS, VIEWS, type View } from '@/components/workbench-contract'
import { usePlugins } from '@/state/plugins'
import { useRemote } from '@/state/remote'
import { runningCount, useTerminals } from '@/state/terminals'
import { useUpdate } from '@/state/update'

export type { View } from '@/components/workbench-contract'

/**
 * Everything this shell offers, behind one rail.
 *
 * The console used to be the whole panel, and bolting three more screens onto
 * it as tabs along the top would have cost the console the height it spends on
 * a log. A vertical rail costs width the log does not need instead, and it is
 * the arrangement every desktop tool with more than one workspace has converged
 * on — so it is also the one a user already knows how to read.
 *
 * The rail carries live state rather than only names: a dot on Remote while a
 * door is open, a count on Plugins. Those are the two facts someone would
 * otherwise have to open a pane to check, and a nav item that answers the
 * question is worth more than one that merely leads to the answer.
 *
 * Which pane is showing belongs to the window rather than to this component,
 * because the keyboard can reach a pane while the harness is the thing in front
 * — and answering Ctrl+3 by switching a pane nobody can see would be worse than
 * not answering it at all.
 */
interface WorkbenchProps {
  hidden: boolean
  view: View
  onSelect: (view: View) => void
}

export function Workbench({ hidden, view, onSelect }: WorkbenchProps) {
  const remoteOpen = useRemote((state) => state.status?.open ?? false)
  // Deliberately not the status bar's rule: that notice can be waved away, and
  // this dot is then the only thing left pointing at where the release is. A
  // rail badge is not an interruption, so it stays until the update is taken.
  const updatable = useUpdate((state) => state.release !== null)
  const refreshPlugins = usePlugins((state) => state.refresh)
  const installed = usePlugins(
    (state) => state.profile?.plugins.filter((plugin) => !plugin.builtin).length ?? 0,
  )
  // Shells still running, which is the one thing about this pane worth knowing
  // from somewhere else: they are this app's children, and the badge is how
  // someone remembers that before closing the window.
  const shells = useTerminals((state) => runningCount(state.tabs))

  // Read once for the badge, not once per visit to the plugin pane — the count
  // has to be true while the user is looking at something else.
  useEffect(() => {
    void refreshPlugins()
  }, [refreshPlugins])

  return (
    <div className={hidden ? 'hidden' : 'flex min-h-0 flex-1'}>
      <nav
        aria-label={t('view.panel')}
        className="chrome relative z-10 flex w-[62px] shrink-0 flex-col items-center gap-0.5 border-r border-line py-2"
      >
        {VIEWS.map((entry, index) => (
          <RailItem
            key={entry.id}
            icon={entry.icon}
            label={t(entry.label)}
            // The tooltip is where a desktop app teaches its accelerators, and
            // the only place someone finds out these exist.
            hint={`${t(entry.label)}  ${ACCELERATOR}${index + 1}`}
            active={view === entry.id}
            onClick={() => onSelect(entry.id)}
            badge={
              entry.id === 'remote' && remoteOpen ? (
                <LiveDot />
              ) : entry.id === 'terminal' && shells > 0 ? (
                <Count value={shells} />
              ) : entry.id === 'plugins' && installed > 0 ? (
                <Count value={installed} />
              ) : entry.id === 'about' && updatable ? (
                <NewsDot />
              ) : undefined
            }
          />
        ))}

        {/* Pushed to the foot and set apart by a rule, because a settings item
            sitting in the numbered run would read as another workspace. */}
        <span aria-hidden="true" className="mt-auto mb-1.5 h-px w-[26px] shrink-0 bg-line" />
        <RailItem
          icon={SETTINGS.icon}
          label={t(SETTINGS.label)}
          hint={`${t(SETTINGS.label)}  ${SETTINGS_KEYS}`}
          active={view === SETTINGS.id}
          onClick={() => onSelect(SETTINGS.id)}
        />
      </nav>

      {/* Keyed so a pane switch replays the settle animation and so no pane
          inherits another's scroll position. The console is the exception: it
          holds a live log and is cheap to keep, so it is only hidden. */}
      <div className="flex min-h-0 flex-1">
        <div className={view === 'console' ? 'flex min-h-0 flex-1' : 'hidden'}>
          <ConsolePane />
        </div>
        {view === 'terminal' && <TerminalPane />}
        {view === 'sessions' && <SessionsPane />}
        {view === 'plugins' && <PluginMarket />}
        {view === 'remote' && <RemotePane />}
        {view === 'about' && <AboutPane />}
        {view === 'settings' && <SettingsPane />}
      </div>
    </div>
  )
}

interface RailItemProps {
  icon: LucideIcon
  label: string
  /** The tooltip: the same name, plus the keystroke that gets here. */
  hint: string
  active: boolean
  badge?: ReactNode
  onClick: () => void
}

function RailItem({ icon: Icon, label, hint, active, badge, onClick }: RailItemProps) {
  return (
    <button
      type="button"
      data-hint={hint}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={[
        'relative flex h-[52px] w-[52px] flex-col items-center justify-center gap-[5px] rounded-panel transition-colors duration-100',
        active ? 'bg-surface-2 text-text' : 'text-faint hover:bg-surface-2/60 hover:text-muted',
      ].join(' ')}
    >
      {/* On the rail's edge rather than on the button, which is what makes it
          read as "you are here in this rail" instead of as a border. */}
      {active && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-[-2px] h-[18px] w-[2.5px] -translate-y-1/2 rounded-full bg-brand"
        />
      )}

      <span className="relative">
        <Icon size={17} strokeWidth={active ? 2.2 : 1.9} aria-hidden="true" />
        {badge && <span className="absolute -top-1 -right-2">{badge}</span>}
      </span>

      <span className="text-[10px] leading-none font-medium">{label}</span>
    </button>
  )
}

/** A door is open. Same colour the status indicator uses for a live service. */
function LiveDot() {
  return (
    <span
      aria-hidden="true"
      className="block size-[6px] rounded-full bg-ok shadow-[0_0_5px_var(--color-ok)]"
    />
  )
}

/** There is a release to read. Brand colour, because it is news and not a fault. */
function NewsDot() {
  return (
    <span
      aria-hidden="true"
      className="block size-[6px] rounded-full bg-brand shadow-[0_0_5px_var(--color-brand)]"
    />
  )
}

function Count({ value }: { value: number }) {
  return (
    <span
      aria-hidden="true"
      className="block min-w-[14px] rounded-full bg-brand px-[3px] text-center text-[9px] leading-[14px] font-semibold text-on-brand tabular-nums"
    >
      {value}
    </span>
  )
}

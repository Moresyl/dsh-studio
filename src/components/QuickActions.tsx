import { useEffect } from 'react'
import { FolderOpen, Layers, MessageSquare, type LucideIcon } from 'lucide-react'

import { PaneHeader } from '@/components/PaneHeader'
import { StatusDot } from '@/components/StatusDot'
import { VIEWS, type View } from '@/components/workbench-contract'
import { t } from '@/lib/i18n'
import type { Status } from '@/lib/ipc'
import { labelOf, toneOf } from '@/lib/status'
import { useHarness } from '@/state/harness'
import { useProfiles } from '@/state/profiles'

interface QuickActionsViewProps {
  status: Status
  /** The profile this window works in, once the roster has been read. */
  profile: string | null
  /** Where the harness's files land. */
  workspace: string | null
  /** Back to the upstream Harness page. */
  onHarness: () => void
  /** Into one of the control panel's panes. */
  onView: (view: View) => void
  onProfiles: () => void
  onWorkspace: () => void
}

const iconOf = (id: View): LucideIcon =>
  VIEWS.find((entry) => entry.id === id)?.icon ?? MessageSquare

/**
 * The page the middle view of the title bar's switch shows.
 *
 * It used to be the Harness page with a strip of buttons laid across the top,
 * which made it look like the first view and made the strip's buttons a trap:
 * pressing one threw the window into the control panel, and the way back was a
 * different view, so the strip was gone by the time you were. Now it is Studio's
 * own page and nothing else — the places people go most, each one press away —
 * and the Harness window stays out of it.
 *
 * Every card is a way into somewhere else, so nothing here keeps state of its
 * own: the destination does that, and this page is what is left when you come
 * back.
 */
export function QuickActionsView({
  status,
  profile,
  workspace,
  onHarness,
  onView,
  onProfiles,
  onWorkspace,
}: QuickActionsViewProps) {
  return (
    <section
      aria-label={t('view.extended')}
      className="flex min-h-0 flex-1 animate-rise flex-col bg-canvas"
    >
      <PaneHeader title={t('view.extended')} subtitle={t('quick.subtitle')} width="narrow" />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto flex max-w-[780px] flex-col gap-4">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            <Action
              icon={MessageSquare}
              title={t('quick.harness')}
              detail={t('quick.harness.body')}
              onClick={onHarness}
            />
            <Action
              icon={iconOf('terminal')}
              title={t('nav.terminal')}
              detail={t('quick.terminal.body')}
              onClick={() => onView('terminal')}
            />
            <Action
              icon={iconOf('sessions')}
              title={t('nav.sessions')}
              detail={t('quick.sessions.body')}
              onClick={() => onView('sessions')}
            />
            <Action
              icon={iconOf('plugins')}
              title={t('nav.plugins')}
              detail={t('quick.plugins.body')}
              onClick={() => onView('plugins')}
            />
            <Action
              icon={Layers}
              title={t('quick.profile')}
              detail={
                profile ? t('quick.profile.current', { name: profile }) : t('quick.profile.body')
              }
              onClick={onProfiles}
            />
            <Action
              icon={FolderOpen}
              title={t('quick.workspace')}
              detail={workspace ?? t('quick.workspace.body')}
              mono={workspace !== null}
              onClick={onWorkspace}
            />
          </div>

          <p className="flex items-center gap-2 text-ui-sm text-muted">
            <StatusDot tone={toneOf(status)} />
            {labelOf(status)}
          </p>
        </div>
      </div>
    </section>
  )
}

interface ActionProps {
  icon: LucideIcon
  title: string
  detail: string
  /** A path or a name, which reads better in the monospace face and is cut at the end. */
  mono?: boolean
  onClick: () => void
}

function Action({ icon: Icon, title, detail, mono = false, onClick }: ActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="card card--interactive flex min-w-0 items-start gap-3 p-4 text-left"
    >
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-brand"
      >
        <Icon size={20} strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-base font-semibold text-text">{title}</span>
        <span
          title={mono ? detail : undefined}
          className={`mt-1 block text-ui-sm text-muted ${mono ? 'truncate font-mono' : 'line-clamp-2'}`}
        >
          {detail}
        </span>
      </span>
    </button>
  )
}

/** The connected page: reads the window's own state and leaves the doing to its caller. */
export function QuickActions(
  props: Pick<QuickActionsViewProps, 'onHarness' | 'onView' | 'onProfiles' | 'onWorkspace'>,
) {
  const status = useHarness((state) => state.status)
  const workspace = useHarness((state) => state.environment?.workspace ?? null)
  const profile = useProfiles((state) => state.roster?.selected || null)
  const refresh = useProfiles((state) => state.refresh)

  // Read on arrival. A window that opened on this page has never shown anything
  // that reads the roster, so without this the profile card would say nothing
  // about which profile it is about to manage.
  useEffect(() => {
    void refresh()
  }, [refresh])

  return <QuickActionsView status={status} profile={profile} workspace={workspace} {...props} />
}

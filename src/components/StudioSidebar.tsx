import { useEffect, type ReactNode } from 'react'
import {
  ChevronRight,
  Info,
  Layers,
  MessageSquareText,
  Search,
  type LucideIcon,
} from 'lucide-react'

import { IconButton } from '@/components/IconButton'
import { ProfileSwitch } from '@/components/ProfileSwitch'
import { SETTINGS, VIEWS, type View } from '@/components/workbench-contract'
import { t } from '@/lib/i18n'
import { ACCELERATOR } from '@/lib/platform'
import { usePlugins } from '@/state/plugins'
import { useRemote } from '@/state/remote'
import { useSessions } from '@/state/sessions'
import { runningCount, useTerminals } from '@/state/terminals'
import { useUpdate } from '@/state/update'

interface StudioSidebarProps {
  collapsed: boolean
  serving: boolean
  inHarness: boolean
  view: View
  onHarness: () => void
  onSelect: (view: View) => void
  onSearch: () => void
  onOpenSession: (id: string) => void
  onManageProfiles?: () => void
}

export function StudioSidebar({
  collapsed,
  serving,
  inHarness,
  view,
  onHarness,
  onSelect,
  onSearch,
  onOpenSession,
  onManageProfiles,
}: StudioSidebarProps) {
  const remoteOpen = useRemote((state) => state.status?.open ?? false)
  const updateReady = useUpdate((state) => state.release !== null)
  const pluginCount = usePlugins(
    (state) => state.profile?.plugins.filter((plugin) => !plugin.builtin).length ?? 0,
  )
  const refreshPlugins = usePlugins((state) => state.refresh)
  const shellCount = useTerminals((state) => runningCount(state.tabs))
  const cards = useSessions((state) => state.cards)
  const archived = useSessions((state) => state.archived)
  const opened = useSessions((state) => state.opened?.card.id ?? state.opening)
  const refreshSessions = useSessions((state) => state.refresh)

  useEffect(() => {
    void refreshPlugins()
  }, [refreshPlugins])

  useEffect(() => {
    if (collapsed) return
    const timer = window.setTimeout(() => void refreshSessions(), 250)
    return () => window.clearTimeout(timer)
  }, [collapsed, refreshSessions])

  const recent = cards?.filter((card) => !archived.includes(card.id)).slice(0, 8) ?? []

  return (
    <aside
      aria-label={t('sidebar.navigation')}
      className={[
        'studio-sidebar chrome flex min-h-0 shrink-0 flex-col border-r border-line transition-[width] duration-150',
        collapsed ? 'w-[52px]' : 'w-[264px]',
      ].join(' ')}
    >
      <nav
        aria-label={t('sidebar.navigation')}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pt-2.5 pb-3"
      >
        {serving && (
          <SidebarItem
            icon={MessageSquareText}
            label={t('view.harness')}
            hint={t('view.harness')}
            collapsed={collapsed}
            active={inHarness}
            onClick={onHarness}
          />
        )}
        <SidebarItem
          icon={Search}
          label={t('sidebar.search')}
          hint={t('sessions.search')}
          collapsed={collapsed}
          active={false}
          onClick={onSearch}
        />

        <div className="my-2.5 border-t border-line" />
        {VIEWS.filter((entry) => entry.id !== 'about').map((entry) => (
          <SidebarItem
            key={entry.id}
            icon={entry.icon}
            label={t(entry.label)}
            hint={`${t(entry.label)}  ${ACCELERATOR}${VIEWS.indexOf(entry) + 1}`}
            collapsed={collapsed}
            active={!inHarness && view === entry.id}
            onClick={() => onSelect(entry.id)}
            badge={
              entry.id === 'remote' && remoteOpen ? (
                <span className="size-1.5 rounded-full bg-ok" />
              ) : entry.id === 'terminal' && shellCount > 0 ? (
                shellCount
              ) : entry.id === 'plugins' && pluginCount > 0 ? (
                pluginCount
              ) : undefined
            }
          />
        ))}

        {!collapsed && recent.length > 0 && (
          <div className="mt-5">
            <div className="flex items-center justify-between pr-0.5 pl-2.5">
              <span className="caption">{t('sidebar.recent')}</span>
              <IconButton
                size="xs"
                label={t('nav.sessions')}
                icon={ChevronRight}
                onClick={() => onSelect('sessions')}
              />
            </div>
            <div className="mt-1 space-y-0.5">
              {recent.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  data-hint={card.title}
                  aria-current={
                    !inHarness && view === 'sessions' && opened === card.id ? 'page' : undefined
                  }
                  onClick={() => onOpenSession(card.id)}
                  className="block h-8 w-full truncate rounded-lg px-2.5 text-left text-ui-base text-muted transition-colors hover:bg-surface-2/70 hover:text-text aria-[current=page]:bg-surface-2 aria-[current=page]:text-text"
                >
                  {card.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className="shrink-0 border-t border-line px-2 py-2">
        <SidebarItem
          icon={Info}
          label={t('nav.about')}
          hint={t('nav.about')}
          collapsed={collapsed}
          active={!inHarness && view === 'about'}
          onClick={() => onSelect('about')}
          badge={updateReady ? <span className="size-1.5 rounded-full bg-brand" /> : undefined}
        />
        <SidebarItem
          icon={SETTINGS.icon}
          label={t(SETTINGS.label)}
          hint={`${t(SETTINGS.label)}  ${ACCELERATOR},`}
          collapsed={collapsed}
          active={!inHarness && view === SETTINGS.id}
          onClick={() => onSelect(SETTINGS.id)}
        />
        {onManageProfiles &&
          (collapsed ? (
            <SidebarItem
              icon={Layers}
              label={t('profile.manage')}
              hint={t('profile.manage')}
              collapsed
              active={false}
              onClick={onManageProfiles}
            />
          ) : (
            <div className="mt-1 border-t border-line pt-2">
              <ProfileSwitch onManage={onManageProfiles} />
            </div>
          ))}
      </div>
    </aside>
  )
}

function SidebarItem({
  icon: Icon,
  label,
  hint,
  collapsed,
  active,
  onClick,
  badge,
}: {
  icon: LucideIcon
  label: string
  hint: string
  collapsed: boolean
  active: boolean
  onClick: () => void
  badge?: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      data-hint={collapsed ? hint : undefined}
      onClick={onClick}
      className={[
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui-base transition-colors duration-100',
        active
          ? 'bg-surface-2 font-medium text-text'
          : 'text-muted hover:bg-surface-2/70 hover:text-text',
      ].join(' ')}
    >
      {/* Collapsed, there is no room beside the icon for a count, so it rides on the
          icon's corner instead — a number in a small chip, a state as its bare dot. */}
      <span className="relative grid shrink-0 place-items-center">
        <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
        {collapsed && badge !== undefined && (
          <span
            aria-hidden="true"
            className={
              typeof badge === 'number'
                ? 'absolute -top-2 -right-2.5 grid h-4 min-w-4 place-items-center rounded-sm bg-brand px-1 text-ui-xs leading-none font-medium text-on-brand tabular-nums'
                : 'absolute -top-1 -right-1 grid place-items-center'
            }
          >
            {badge}
          </span>
        )}
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && badge !== undefined && (
        <span className="text-ui-sm text-faint tabular-nums" aria-hidden="true">
          {badge}
        </span>
      )}
    </button>
  )
}

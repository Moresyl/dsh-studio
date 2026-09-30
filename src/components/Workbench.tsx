import { lazy, Suspense } from 'react'

import { ConsolePane } from '@/components/ConsolePane'
import { t } from '@/lib/i18n'
import type { View } from '@/components/workbench-contract'

const AboutPane = lazy(() =>
  import('@/components/AboutPane').then((module) => ({ default: module.AboutPane })),
)
const PluginMarket = lazy(() =>
  import('@/components/PluginMarket').then((module) => ({ default: module.PluginMarket })),
)
const RemotePane = lazy(() =>
  import('@/components/RemotePane').then((module) => ({ default: module.RemotePane })),
)
const SessionsPane = lazy(() =>
  import('@/components/SessionsPane').then((module) => ({ default: module.SessionsPane })),
)
const SettingsPane = lazy(() =>
  import('@/components/SettingsPane').then((module) => ({ default: module.SettingsPane })),
)
const TerminalPane = lazy(() =>
  import('@/components/TerminalPane').then((module) => ({ default: module.TerminalPane })),
)
const PresentationsPane = lazy(() =>
  import('@/components/PresentationsPane').then((module) => ({
    default: module.PresentationsPane,
  })),
)
const WorkspacesPane = lazy(() =>
  import('@/components/WorkspacesPane').then((module) => ({ default: module.WorkspacesPane })),
)
const PromptLibraryPane = lazy(() =>
  import('@/components/PromptLibraryPane').then((module) => ({
    default: module.PromptLibraryPane,
  })),
)

export type { View } from '@/components/workbench-contract'

interface WorkbenchProps {
  hidden: boolean
  view: View
  onView: (view: View) => void
}

export function Workbench({ hidden, view, onView }: WorkbenchProps) {
  return (
    <div className={hidden ? 'hidden' : 'flex min-h-0 flex-1 bg-canvas'}>
      <div className={view === 'console' ? 'flex min-h-0 flex-1' : 'hidden'}>
        <ConsolePane />
      </div>
      <Suspense fallback={<PaneLoading />}>
        {view === 'terminal' && <TerminalPane />}
        {view === 'sessions' && <SessionsPane />}
        {view === 'plugins' && <PluginMarket />}
        {view === 'remote' && <RemotePane />}
        {view === 'about' && <AboutPane />}
        {view === 'settings' && <SettingsPane />}
        {view === 'presentations' && <PresentationsPane />}
        {view === 'workspaces' && <WorkspacesPane onSessions={() => onView('sessions')} />}
        {view === 'library' && <PromptLibraryPane />}
      </Suspense>
    </div>
  )
}

function PaneLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-1 items-center justify-center text-ui-base"
    >
      <span className="shimmer">{t('common.loading')}</span>
    </div>
  )
}

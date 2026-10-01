import { useEffect, useMemo, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { FolderOpen, MessagesSquare, RefreshCw, Search } from 'lucide-react'
import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { Empty } from '@/components/Empty'
import { IconButton } from '@/components/IconButton'
import { PaneHeader } from '@/components/PaneHeader'
import { WorktreeManager } from '@/components/WorktreeManager'
import { WorktreeReview } from '@/components/WorktreeReview'
import { WorkspaceFiles } from '@/components/WorkspaceFiles'
import { count, leaf, when } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { GitWorktree } from '@/lib/ipc'
import { workspaceKey, workspaceSummaries } from '@/lib/workspace-summary'
import { reportAction } from '@/state/failure'
import { useHarness } from '@/state/harness'
import { useSessions } from '@/state/sessions'
import { switchWorkspace } from '@/state/workspace'

export function WorkspacesPane({ onSessions }: { onSessions: () => void }) {
  const current = useHarness((state) => state.environment?.workspace ?? null)
  const cards = useSessions((state) => state.cards)
  const refresh = useSessions((state) => state.refresh)
  const loading = useSessions((state) => state.scanning)
  const error = useSessions((state) => state.error)
  const [query, setQuery] = useState('')
  const [review, setReview] = useState<GitWorktree | null>(null)
  const [switching, setSwitching] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  useEffect(() => {
    void refresh()
  }, [refresh])
  const workspaces = useMemo(
    () =>
      workspaceSummaries(cards ?? [], current).filter((item) =>
        item.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    [cards, current, query],
  )
  const select = async (path?: string) => {
    if (switching) return
    setSwitching(true)
    try {
      await reportAction(async () => {
        const chosen =
          path ??
          (await open({
            title: t('workspace.choose'),
            directory: true,
            multiple: false,
            defaultPath: current ?? undefined,
          }))
        if (typeof chosen === 'string') await switchWorkspace(chosen)
      })
    } finally {
      setSwitching(false)
    }
  }
  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col bg-canvas">
      <PaneHeader title={t('nav.workspaces')} subtitle={t('workspace.subtitle')}>
        <IconButton
          icon={RefreshCw}
          label={t('sessions.refresh')}
          disabled={loading}
          onClick={() => void refresh()}
        />
        <Button disabled={switching} onClick={() => void select()}>
          <FolderOpen />
          {t('workspace.choose')}
        </Button>
        <Button
          variant="secondary"
          disabled={switching || !current}
          onClick={() => setBrowsing(true)}
        >
          <FolderOpen />
          {t('files.open')}
        </Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto flex max-w-[1040px] flex-col gap-5">
          <label className="field-shell">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              aria-label={t('workspace.search')}
              placeholder={t('workspace.search')}
              className="selectable"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-ui-sm text-danger">
              {error}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {workspaces.map((item) => (
              <article key={item.path} className="card flex min-w-0 flex-col gap-4 p-5">
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2">
                    <FolderOpen size={20} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-ui-lg font-medium">
                      {leaf(item.path) || item.path}
                    </h2>
                    <p className="selectable mt-1 truncate text-ui-sm text-faint" title={item.path}>
                      {item.path}
                    </p>
                  </div>
                  {item.current && <Badge>{t('workspace.current')}</Badge>}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-ui-sm text-muted">
                  <span>
                    {t('workspace.summary', { sessions: item.sessions, turns: item.turns })}
                  </span>
                  <span>{count(item.tokens)} tokens</span>
                  {item.touched > 0 && (
                    <span>{t('workspace.lastActivity', { time: when(item.touched) })}</span>
                  )}
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const project =
                        cards?.find(
                          (card) => workspaceKey(card.project) === workspaceKey(item.path),
                        )?.project ?? item.path
                      useSessions.getState().close()
                      useSessions.getState().setTab('list')
                      void useSessions.getState().narrow(project)
                      onSessions()
                    }}
                  >
                    <MessagesSquare />
                    {t('workspace.sessions')}
                  </Button>
                  {!item.current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={switching}
                      onClick={() => void select(item.path)}
                    >
                      {t('workspace.switch')}
                    </Button>
                  )}
                  <IconButton
                    icon={FolderOpen}
                    label={t('statusbar.reveal')}
                    size="sm"
                    onClick={() => void reportAction(() => revealItemInDir(item.path))}
                  />
                </div>
              </article>
            ))}
          </div>
          {workspaces.length === 0 && (
            <Empty
              icon={FolderOpen}
              message={t('workspace.empty')}
              hint={t('workspace.emptyHint')}
            />
          )}
          <WorktreeManager key={current} onReview={setReview} />
        </div>
      </div>
      {review && <WorktreeReview worktree={review} onClose={() => setReview(null)} />}
      {browsing && <WorkspaceFiles onClose={() => setBrowsing(false)} />}
    </section>
  )
}

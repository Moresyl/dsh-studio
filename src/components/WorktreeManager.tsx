import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  FolderOpen,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { reportAction } from '@/state/failure'
import { switchWorkspace } from '@/state/workspace'

const asWorktrees = (value: unknown): ipc.GitWorktree[] =>
  Array.isArray(value) ? (value as ipc.GitWorktree[]) : []

/**
 * Git-native isolation for parallel agent tasks. No destructive remove action
 * is offered: dirty branches stay visible until reviewed in ordinary Git.
 *
 * Two list cards rather than one bordered box with sections in it: the first
 * holds what this is and the one thing it can do, in the same rows the settings
 * above it are made of, and the second holds what exists. The state that says
 * there is nothing to list takes the second card's place, so the two never read
 * as one thing that is half empty.
 */
export function WorktreeManager({ onReview }: { onReview: (worktree: ipc.GitWorktree) => void }) {
  const [items, setItems] = useState<ipc.GitWorktree[]>([])
  const [branch, setBranch] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const notRepository = !loading && items.length === 0 && error === null

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems(asWorktrees(await ipc.workspaceWorktrees()))
    } catch (cause) {
      setItems([])
      setError(describe(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void ipc
      .workspaceWorktrees()
      .then((worktrees) => {
        if (active) setItems(asWorktrees(worktrees))
      })
      .catch((cause: unknown) => {
        if (active) setError(describe(cause))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const create = async () => {
    const name = branch.trim()
    if (!name || creating) return
    setCreating(true)
    setError(null)
    try {
      setItems(asWorktrees(await ipc.workspaceWorktreeCreate(name)))
      setBranch('')
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="list-card">
        <header className="list-row list-row--roomy">
          <GitBranch
            size={16}
            strokeWidth={1.9}
            className="shrink-0 text-faint"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <h3 className="text-ui-base font-medium text-text">{t('worktrees.title')}</h3>
            <p className="text-ui-sm text-faint">{t('worktrees.subtitle')}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || creating}
            onClick={() => void refresh()}
            className="-mr-2"
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden="true" />
            {t('action.recheck')}
          </Button>
        </header>

        <div className="list-row list-row--roomy flex-col items-stretch gap-2">
          <div className="flex gap-2">
            <input
              value={branch}
              disabled={creating || loading || notRepository}
              placeholder={t('worktrees.branchPlaceholder')}
              aria-label={t('worktrees.branch')}
              onChange={(event) => setBranch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
              className="field-control min-w-0 flex-1 font-mono"
            />
            <Button
              disabled={!branch.trim() || creating || loading || notRepository}
              onClick={() => void create()}
            >
              {creating ? <Loader2 className="animate-spin" /> : <Plus />}
              {creating ? t('worktrees.creating') : t('worktrees.create')}
            </Button>
          </div>
          <p className="text-ui-sm text-faint">{t('worktrees.guard')}</p>
        </div>
      </div>

      {items.length > 0 && (
        <ul className="list-card">
          {items.map((item) => (
            <li key={item.path} className="list-row list-row--roomy">
              {item.dirty ? (
                <TriangleAlert
                  size={16}
                  strokeWidth={1.9}
                  className="shrink-0 text-warn"
                  aria-hidden="true"
                />
              ) : (
                <CheckCircle2
                  size={16}
                  strokeWidth={1.9}
                  className="shrink-0 text-ok"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-mono text-ui-sm font-medium text-text">
                  <GitBranch
                    size={14}
                    strokeWidth={1.9}
                    className="shrink-0 text-faint"
                    aria-hidden="true"
                  />
                  <span className="truncate">{item.branch}</span>
                  {item.primary && <Badge>{t('worktrees.primary')}</Badge>}
                  {item.dirty && <Badge tone="warn">{t('worktrees.dirty')}</Badge>}
                </p>
                <p className="truncate font-mono text-ui-sm text-faint">
                  {item.head} · {item.path}
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => onReview(item)}>
                {t('worktrees.review')}
              </Button>
              <IconButton
                icon={FolderOpen}
                label={t('statusbar.reveal')}
                onClick={() => void reportAction(() => revealItemInDir(item.path))}
              />
              {item.primary ? (
                // The worktree that is already open has nothing to switch to, and
                // without something in its place its buttons would sit further right
                // than everyone else's. Hidden rather than absent so the gap is
                // whatever this label is in this language, and out of the tab order
                // and the accessibility tree because `visibility` takes it out of both.
                <Button variant="secondary" size="sm" className="invisible" aria-hidden="true">
                  {t('worktrees.use')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void switchWorkspace(item.path)}
                >
                  {t('worktrees.use')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!loading && items.length === 0 && !error && (
        <div className="list-card">
          <p className="list-row text-ui-base text-muted">{t('worktrees.empty')}</p>
        </div>
      )}
      {error && (
        <p className="selectable rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </section>
  )
}

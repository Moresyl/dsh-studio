import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, FolderOpen, GitBranch, Loader2, Plus, TriangleAlert } from 'lucide-react'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import { Button } from '@/components/Button'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { switchWorkspace } from '@/state/workspace'

/** Git-native isolation for parallel agent tasks. No destructive remove action
 * is offered: dirty branches stay visible until reviewed in ordinary Git. */
export function WorktreeManager() {
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
      setItems(await ipc.workspaceWorktrees())
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
        if (active) setItems(worktrees)
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
      setItems(await ipc.workspaceWorktreeCreate(name))
      setBranch('')
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="overflow-hidden rounded-panel border border-line bg-canvas-deep/50">
      <header className="flex items-start gap-3 border-b border-line px-4 py-3.5">
        <GitBranch size={15} className="mt-0.5 shrink-0 text-brand" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[12.5px] font-medium text-text">{t('worktrees.title')}</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-faint">{t('worktrees.subtitle')}</p>
        </div>
        <Button variant="ghost" disabled={loading || creating} onClick={() => void refresh()}>
          {loading ? <Loader2 size={12} className="animate-spin" /> : t('action.recheck')}
        </Button>
      </header>

      <div className="border-b border-line p-3">
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
            className="h-[30px] min-w-0 flex-1 rounded-control border border-line-strong bg-surface-2 px-2.5 font-mono text-[11.5px] text-text outline-none placeholder:font-sans placeholder:text-faint focus:border-brand disabled:opacity-40"
          />
          <Button
            disabled={!branch.trim() || creating || loading || notRepository}
            onClick={() => void create()}
          >
            {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            {creating ? t('worktrees.creating') : t('worktrees.create')}
          </Button>
        </div>
        <p className="mt-2 text-[10.5px] leading-relaxed text-faint">{t('worktrees.guard')}</p>
      </div>

      {items.length > 0 && (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.path} className="flex items-center gap-3 px-4 py-3">
              {item.dirty ? (
                <TriangleAlert size={13} className="shrink-0 text-warn" aria-hidden="true" />
              ) : (
                <CheckCircle2 size={13} className="shrink-0 text-ok" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[11.5px] font-medium text-text">
                  <GitBranch size={11} aria-hidden="true" />
                  <span className="truncate">{item.branch}</span>
                  {item.primary && (
                    <span className="rounded-full bg-brand/12 px-1.5 py-0.5 text-[9.5px] text-brand">
                      {t('worktrees.primary')}
                    </span>
                  )}
                  {item.dirty && (
                    <span className="rounded-full bg-warn/12 px-1.5 py-0.5 text-[9.5px] text-warn">
                      {t('worktrees.dirty')}
                    </span>
                  )}
                </p>
                <p className="mt-1 truncate font-mono text-[10px] text-faint">
                  {item.head} · {item.path}
                </p>
              </div>
              <Button
                variant="ghost"
                data-hint={t('statusbar.reveal')}
                aria-label={t('statusbar.reveal')}
                onClick={() => void revealItemInDir(item.path)}
              >
                <FolderOpen size={12} aria-hidden="true" />
              </Button>
              {!item.primary && (
                <Button variant="secondary" onClick={() => void switchWorkspace(item.path)}>
                  {t('worktrees.use')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!loading && items.length === 0 && !error && (
        <p className="px-4 py-4 text-[11.5px] text-faint">{t('worktrees.empty')}</p>
      )}
      {error && (
        <p className="selectable border-t border-danger/20 bg-danger/8 px-4 py-2.5 text-[11px] leading-relaxed text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

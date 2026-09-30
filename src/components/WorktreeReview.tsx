import { useEffect, useRef, useState } from 'react'
import { FileDiff, Loader2, RefreshCw, X } from 'lucide-react'

import { IconButton } from '@/components/IconButton'
import { Segmented } from '@/components/Segmented'
import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import * as ipc from '@/lib/ipc'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import { changeCounts, diffLineKind } from '@/lib/worktree-review'

type View = 'files' | 'unstaged' | 'staged'

const lineTone = {
  file: 'bg-surface-2 font-medium text-text',
  hunk: 'bg-brand/8 text-brand',
  added: 'bg-ok/8 text-ok',
  removed: 'bg-danger/8 text-danger',
  context: 'text-muted',
}

/** A read-only snapshot. Nothing here stages, restores, merges or discards work. */
export function WorktreeReview({
  worktree,
  onClose,
}: {
  worktree: ipc.GitWorktree
  onClose: () => void
}) {
  const card = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const [review, setReview] = useState<ipc.GitReview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<View>('files')

  useEffect(() => {
    const previous = document.activeElement
    close.current?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  useEffect(() => {
    let active = true
    void ipc
      .workspaceWorktreeReview(worktree.path)
      .then((value) => {
        if (active) setReview(value)
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
  }, [worktree.path, revision])

  const refresh = () => {
    // Disabling the focused refresh button makes WebView move focus to body.
    // Keep a live stop inside the modal while the native request runs or fails.
    close.current?.focus()
    setLoading(true)
    setError(null)
    setReview(null)
    setRevision((value) => value + 1)
  }
  const counts = changeCounts(review?.changes ?? [])
  const patch = review && view !== 'files' ? review[view] : null

  return (
    <div
      role="presentation"
      onMouseDown={(event) => pressedBackdrop(event, onClose)}
      onKeyDown={(event) => holdFocus(card.current, event, onClose)}
      className="dialog-backdrop fixed inset-0 z-30 grid animate-fade place-items-center bg-canvas-deep/70 p-4 backdrop-blur-[2px] sm:p-8"
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={t('worktrees.review')}
        className="dialog-panel flex h-[min(760px,85vh)] max-h-full w-full max-w-[1000px] animate-pop flex-col overflow-hidden rounded-xl border border-line-strong bg-surface shadow-lift"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-4">
          <FileDiff size={20} className="shrink-0 text-brand" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-ui-lg font-semibold text-text">
              {t('worktrees.review')} · {worktree.branch}
            </h2>
            <p className="truncate font-mono text-ui-sm text-faint" title={worktree.path}>
              {worktree.path}
            </p>
          </div>
          <IconButton
            label={t('action.recheck')}
            icon={RefreshCw}
            disabled={loading}
            onClick={refresh}
          />
          <IconButton ref={close} label={t('window.close')} icon={X} onClick={onClose} />
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <Segmented
            size="sm"
            label={t('worktrees.reviewViews')}
            value={view}
            onChange={setView}
            items={[
              {
                value: 'files',
                label: t('worktrees.files', { count: review?.changes.length ?? 0 }),
              },
              { value: 'unstaged', label: t('worktrees.unstaged', { count: counts.unstaged }) },
              { value: 'staged', label: t('worktrees.staged', { count: counts.staged }) },
            ]}
          />
          {counts.untracked > 0 && (
            <span className="text-ui-sm text-faint">
              {t('worktrees.untracked', { count: counts.untracked })}
            </span>
          )}
        </div>
        <div
          className="min-h-0 flex-1 overflow-auto"
          tabIndex={0}
          role="region"
          aria-label={t('worktrees.reviewContent')}
          aria-busy={loading}
        >
          {loading ? (
            <p
              className="flex items-center justify-center gap-2 p-8 text-ui-base text-muted"
              role="status"
            >
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              {t('worktrees.reviewLoading')}
            </p>
          ) : error ? (
            <p
              className="selectable m-5 rounded-lg border border-danger/20 bg-danger/8 p-4 text-ui-sm text-danger"
              role="alert"
            >
              {error}
            </p>
          ) : view === 'files' ? (
            review?.changes.length ? (
              <table className="w-full border-collapse text-left text-ui-sm">
                <thead className="sticky top-0 bg-surface text-ui-xs text-faint">
                  <tr>
                    <th scope="col" className="w-20 px-4 py-3 font-medium">
                      {t('worktrees.indexColumn')}
                    </th>
                    <th scope="col" className="w-24 px-4 py-3 font-medium">
                      {t('worktrees.worktreeColumn')}
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      {t('worktrees.pathColumn')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {review.changes.map((change) => (
                    <tr key={change.path} className="border-t border-line hover:bg-surface-2/50">
                      <td className="px-4 py-2.5 font-mono text-muted">
                        {change.index.trim() || '—'}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-muted">
                        {change.worktree.trim() || '—'}
                      </td>
                      <td className="selectable break-all px-4 py-2.5 font-mono text-text">
                        {change.previousPath && (
                          <span className="text-faint">{change.previousPath} → </span>
                        )}
                        {change.path}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="p-8 text-center text-ui-base text-muted">{t('worktrees.clean')}</p>
            )
          ) : patch?.tooLarge ? (
            <p className="m-5 rounded-lg border border-warn/25 bg-warn/8 p-4 text-ui-sm text-warn">
              {t('worktrees.patchTooLarge')}
            </p>
          ) : patch?.text ? (
            <pre className="selectable min-w-max py-3 font-mono text-ui-sm leading-5" dir="ltr">
              {patch.text.split('\n').map((line, index) => (
                <span key={index} className={`block px-4 ${lineTone[diffLineKind(line)]}`}>
                  {line || ' '}
                </span>
              ))}
            </pre>
          ) : (
            <p className="p-8 text-center text-ui-base text-muted">{t('worktrees.noPatch')}</p>
          )}
        </div>
        <footer className="shrink-0 border-t border-line px-5 py-3 text-ui-xs text-faint">
          <p>{t('worktrees.reviewGuard')}</p>
          {view === 'files' && <p className="mt-1">{t('worktrees.legend')}</p>}
        </footer>
      </div>
    </div>
  )
}

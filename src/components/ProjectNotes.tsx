import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ClipboardCopy,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
import { t } from '@/lib/i18n'
import { when } from '@/lib/format'
import { useProjectNotes, notesDirty } from '@/state/project-notes'
import { ask } from '@/state/dialog'
import { reportAction } from '@/state/failure'

export function ProjectNotes({ workspace }: { workspace: string | null }) {
  const state = useProjectNotes()
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void useProjectNotes.getState().load()
  }, [workspace])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])
  const notes = useMemo(
    () =>
      state.notes.filter((note) =>
        `${note.title}\n${note.body}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      ),
    [state.notes, query],
  )
  const dirty = notesDirty(state)
  const blocked = state.locked || state.busy !== null
  return (
    <section className="card overflow-hidden" aria-label={t('notes.title')}>
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <FileText size={18} aria-hidden="true" className="text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="text-ui-lg font-medium">{t('notes.title')}</h2>
          <p className="text-ui-sm text-faint">{t('notes.subtitle')}</p>
        </div>
        <IconButton
          icon={RefreshCw}
          label={t('notes.refresh')}
          disabled={blocked || dirty}
          onClick={() => void state.load()}
        />
        <Button size="sm" disabled={!state.root || blocked} onClick={() => void state.choose(null)}>
          <Plus />
          {t('notes.new')}
        </Button>
      </header>
      {state.error && (
        <p
          role="alert"
          className="selectable border-b border-line px-5 py-3 text-ui-sm text-danger"
        >
          {state.error}
        </p>
      )}
      {state.recovered.length > 0 && (
        <details className="border-b border-line px-5 py-3">
          <summary className="cursor-pointer text-ui-sm font-medium text-warn">
            {t('notes.recovered', { count: state.recovered.length })}
          </summary>
          <p className="mt-2 text-ui-sm text-faint">{t('notes.recoveryHint')}</p>
          {state.recovered.map((draft) => (
            <div key={draft.editor} className="mt-3 flex flex-wrap items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate text-ui-sm"
                title={draft.note.body.slice(0, 500)}
              >
                {draft.note.title}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={blocked}
                onClick={() => void state.recover(draft.editor)}
              >
                {t('notes.restore')}
              </Button>
              <IconButton
                icon={Trash2}
                label={t('notes.discardDraft')}
                disabled={blocked || dirty}
                onClick={() =>
                  void ask({
                    title: t('notes.discardDraft'),
                    body: t('notes.discardDraftBody'),
                    subject: draft.note.title,
                    confirm: t('notes.discardDraft'),
                    tone: 'danger',
                  }).then((confirmed) => {
                    if (confirmed) void useProjectNotes.getState().discardDraft(draft.editor)
                  })
                }
              />
            </div>
          ))}
        </details>
      )}
      <div className="grid min-h-[320px] md:grid-cols-[minmax(180px,0.6fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col gap-3 border-b border-line p-4 md:border-r md:border-b-0">
          <label className="field-shell">
            <Search size={16} aria-hidden="true" />
            <input
              className="selectable"
              type="search"
              aria-label={t('notes.search')}
              placeholder={t('notes.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="max-h-[360px] overflow-y-auto" aria-busy={state.busy === 'load'}>
            {notes.length === 0 && (
              <p className="p-3 text-ui-sm text-faint">
                {t(
                  state.busy === 'load'
                    ? 'notes.loading'
                    : query.trim()
                      ? 'notes.noResults'
                      : 'notes.empty',
                )}
              </p>
            )}
            {notes.map((note) => (
              <button
                key={note.id}
                type="button"
                aria-pressed={state.draft?.id === note.id}
                disabled={blocked}
                onClick={() => {
                  setCopied(false)
                  void state.choose(note.id)
                }}
                className={`mb-1 flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-50 ${state.draft?.id === note.id ? 'bg-surface-2' : ''}`}
              >
                <span className="max-w-full truncate text-ui-base font-medium">{note.title}</span>
                <span className="max-w-full truncate text-ui-sm text-faint">
                  {note.body.replace(/\s+/g, ' ').slice(0, 100) || t('notes.blank')}
                </span>
                <span className="text-ui-xs text-faint">{when(note.updated)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3 p-4">
          {state.draft ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  role="status"
                  aria-live="polite"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-sm text-muted"
                >
                  {state.busy === 'save' ? (
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  ) : !dirty ? (
                    <Check size={14} aria-hidden="true" />
                  ) : null}
                  {t(
                    state.busy === 'save'
                      ? 'notes.saving'
                      : state.error && dirty
                        ? 'notes.notSaved'
                        : dirty
                          ? 'notes.pending'
                          : 'notes.saved',
                  )}
                </span>
                {state.error && dirty && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={blocked}
                    onClick={() => void state.saveCopy()}
                  >
                    {t('notes.saveCopy')}
                  </Button>
                )}
                {dirty && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={blocked}
                    onClick={() => {
                      const expected = state.draft!
                      void ask({
                        title: t('organize.discardTitle'),
                        body: t('organize.discardBody'),
                        subject: expected.title,
                        confirm: t('organize.discard'),
                        tone: 'danger',
                      }).then((confirmed) => {
                        if (confirmed) useProjectNotes.getState().discard(expected)
                      })
                    }}
                  >
                    {t('organize.discard')}
                  </Button>
                )}
                <IconButton
                  icon={copied ? Check : ClipboardCopy}
                  label={t(copied ? 'library.copied' : 'files.copy')}
                  onClick={() =>
                    void reportAction(async () => {
                      await navigator.clipboard.writeText(state.draft!.body)
                      setCopied(true)
                    })
                  }
                />
                <IconButton
                  icon={Save}
                  label={t('notes.save')}
                  disabled={blocked || !dirty}
                  onClick={() => void state.save()}
                />
                <IconButton
                  icon={Trash2}
                  label={t('notes.remove')}
                  disabled={blocked || state.draft.revision === 0}
                  onClick={() => {
                    const note = state.draft!
                    void ask({
                      title: t('notes.remove'),
                      body: t('notes.removeBody'),
                      subject: note.title,
                      confirm: t('notes.remove'),
                      tone: 'danger',
                    }).then((confirmed) => {
                      if (confirmed) void useProjectNotes.getState().remove(note.id)
                    })
                  }}
                />
              </div>
              <input
                className="field-control selectable"
                aria-label={t('notes.name')}
                maxLength={240}
                value={state.draft.title}
                disabled={state.locked || (state.busy !== null && state.busy !== 'save')}
                onChange={(event) => {
                  setCopied(false)
                  state.change({ title: event.target.value })
                }}
              />
              <textarea
                className="field-control selectable min-h-60 flex-1 resize-y leading-relaxed"
                aria-label={t('notes.body')}
                placeholder={t('notes.bodyHint')}
                value={state.draft.body}
                maxLength={65536}
                disabled={state.locked || (state.busy !== null && state.busy !== 'save')}
                onChange={(event) => {
                  setCopied(false)
                  state.change({ body: event.target.value })
                }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                    event.preventDefault()
                    void state.save()
                  }
                }}
              />
              <p className="text-ui-xs text-faint">
                {t('notes.storageHint')} ·{' '}
                {new TextEncoder().encode(state.draft.body).length.toLocaleString()} / 65,536 bytes
              </p>
            </>
          ) : (
            <p className="m-auto p-5 text-center text-ui-sm text-faint">{t('notes.choose')}</p>
          )}
        </div>
      </div>
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  Check,
  ClipboardCopy,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { Empty } from '@/components/Empty'
import { IconButton } from '@/components/IconButton'
import { PaneHeader } from '@/components/PaneHeader'
import { t } from '@/lib/i18n'
import type { SavedPrompt } from '@/lib/ipc'
import { PersonalDialog as LibraryDialog } from '@/components/PersonalDialog'
import { LibraryTransfer } from '@/components/LibraryTransfer'
import { promptVariables, renderPrompt } from '@/lib/prompt-template'
import { ask } from '@/state/dialog'
import { reportAction } from '@/state/failure'
import { parseTags, validTags, useLibrary } from '@/state/library'

export function PromptLibraryPane() {
  const { data, loaded, loading, busy, error, load, removePrompt } = useLibrary()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<SavedPrompt | null>(null)
  const [using, setUsing] = useState<SavedPrompt | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (copied === null) return
    const timer = window.setTimeout(() => setCopied(null), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])
  const prompts = useMemo(
    () =>
      Object.values(data.prompts)
        .filter((prompt) =>
          [prompt.title, prompt.body, ...prompt.tags]
            .join(' ')
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [data.prompts, query],
  )
  const copy = async (prompt: SavedPrompt) => {
    if (promptVariables(prompt.body).length > 0) {
      setUsing(prompt)
      return
    }
    await reportAction(async () => {
      await navigator.clipboard.writeText(prompt.body)
      setCopied(prompt.id)
    })
  }
  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col bg-canvas">
      <PaneHeader title={t('nav.library')} subtitle={t('library.subtitle')}>
        <IconButton
          icon={RefreshCw}
          label={t('sessions.refresh')}
          variant="secondary"
          size="md"
          disabled={loading || busy}
          onClick={() => void load()}
        />
        <Button
          disabled={!loaded || busy}
          onClick={() => setEditing({ id: crypto.randomUUID(), title: '', body: '', tags: [] })}
        >
          <Plus />
          {t('library.new')}
        </Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto max-w-[1040px]">
          <div className="mb-4">
            <LibraryTransfer promptsOnly />
          </div>
          <label className="field-shell mb-5">
            <Search size={16} aria-hidden="true" />
            <input
              className="selectable"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('library.search')}
              placeholder={t('library.search')}
            />
          </label>
          {error && (
            <p role="alert" className="mb-4 text-ui-sm text-danger">
              {error}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {prompts.map((prompt) => (
              <article key={prompt.id} className="card flex min-w-0 flex-col gap-3 p-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2">
                    <BookOpen size={18} aria-hidden="true" />
                  </span>
                  <h2 className="min-w-0 flex-1 truncate text-ui-lg font-medium">{prompt.title}</h2>
                  <IconButton
                    icon={Pencil}
                    label={t('library.edit')}
                    disabled={busy}
                    onClick={() => setEditing(prompt)}
                  />
                  <IconButton
                    icon={Trash2}
                    label={t('library.remove')}
                    disabled={busy}
                    onClick={() =>
                      void ask({
                        title: t('library.remove'),
                        body: t('library.removeBody'),
                        subject: prompt.title,
                        confirm: t('library.remove'),
                        tone: 'danger',
                      }).then((confirmed) => {
                        if (confirmed) void removePrompt(prompt.id)
                      })
                    }
                  />
                </div>
                <p className="selectable line-clamp-4 whitespace-pre-wrap text-ui-base leading-relaxed text-muted">
                  {prompt.body}
                </p>
                <div className="flex flex-wrap gap-1">
                  {prompt.tags.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
                <div className="mt-auto pt-1">
                  <Button variant="secondary" size="sm" onClick={() => void copy(prompt)}>
                    {copied === prompt.id ? <Check /> : <ClipboardCopy />}
                    {t(copied === prompt.id ? 'library.copied' : 'library.copy')}
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {prompts.length === 0 && (
            <Empty
              icon={BookOpen}
              message={t(query ? 'library.noResults' : 'library.empty')}
              hint={t('library.emptyHint')}
            />
          )}
          {!query && (
            <div className="mt-6 grid gap-3 md:grid-cols-3">
              {(['review', 'plan', 'explain'] as const).map((kind) => (
                <button
                  type="button"
                  key={kind}
                  disabled={!loaded || busy}
                  className="card flex items-center gap-3 p-4 text-left transition-colors hover:bg-surface-2"
                  onClick={() =>
                    setEditing({
                      id: crypto.randomUUID(),
                      title: t(`library.starter.${kind}`),
                      body: t(`library.starter.${kind}Body`),
                      tags: [],
                    })
                  }
                >
                  <Plus size={16} className="shrink-0 text-faint" aria-hidden="true" />
                  <span className="text-ui-base">{t(`library.starter.${kind}`)}</span>
                </button>
              ))}
            </div>
          )}
          <p className="mt-6 text-ui-sm leading-relaxed text-faint">{t('library.notice')}</p>
        </div>
      </div>
      {editing && (
        <PromptEditor key={editing.id} prompt={editing} onClose={() => setEditing(null)} />
      )}
      {using && <PromptUse key={using.id} prompt={using} onClose={() => setUsing(null)} />}
    </section>
  )
}

function PromptEditor({ prompt, onClose }: { prompt: SavedPrompt; onClose: () => void }) {
  const [title, setTitle] = useState(prompt.title)
  const [body, setBody] = useState(prompt.body)
  const [tags, setTags] = useState(prompt.tags.join(', '))
  const busy = useLibrary((state) => state.busy)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    useLibrary.setState({ editing: true })
    return () => useLibrary.setState({ editing: false })
  }, [])
  const dismiss = async () => {
    if (busy || confirming) return
    const dirty = title !== prompt.title || body !== prompt.body || tags !== prompt.tags.join(', ')
    setConfirming(true)
    if (
      !dirty ||
      (await ask({
        title: t('organize.discardTitle'),
        body: t('organize.discardBody'),
        confirm: t('organize.discard'),
        tone: 'danger',
      }))
    )
      onClose()
    setConfirming(false)
  }
  return (
    <LibraryDialog title={t('library.edit')} onClose={() => void dismiss()}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!validTags(tags)) return
          void useLibrary
            .getState()
            .savePrompt({ id: prompt.id, title: title.trim(), body, tags: parseTags(tags) })
            .then((saved) => {
              if (saved) onClose()
            })
        }}
      >
        <label className="flex flex-col gap-2 text-ui-sm text-muted">
          {t('library.title')}
          <input
            className="field-control selectable"
            required
            maxLength={240}
            disabled={busy}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-2 text-ui-sm text-muted">
          {t('library.body')}
          <textarea
            className="field-control selectable min-h-52 resize-y"
            required
            maxLength={32000}
            disabled={busy}
            value={body}
            placeholder="{{topic}}"
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-2 text-ui-sm text-muted">
          {t('organize.tags')}
          <input
            className="field-control selectable"
            maxLength={400}
            disabled={busy}
            value={tags}
            placeholder={t('organize.tagsHint')}
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
        {!validTags(tags) && (
          <p role="alert" className="text-ui-sm text-danger">
            {t('organize.tagsLimit')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => void dismiss()}>
            {t('dialog.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={busy || !title.trim() || !body.trim() || !validTags(tags)}
          >
            <Save />
            {t('organize.save')}
          </Button>
        </div>
      </form>
    </LibraryDialog>
  )
}

function PromptUse({ prompt, onClose }: { prompt: SavedPrompt; onClose: () => void }) {
  const variables = promptVariables(prompt.body)
  const [values, setValues] = useState<Map<string, string>>(new Map())
  const text = renderPrompt(prompt.body, values)
  const [copying, setCopying] = useState(false)
  return (
    <LibraryDialog title={prompt.title} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (copying) return
          setCopying(true)
          void reportAction(async () => {
            await navigator.clipboard.writeText(text)
            onClose()
          }).finally(() => setCopying(false))
        }}
      >
        {variables.map((variable) => (
          <label key={variable} className="flex flex-col gap-2 text-ui-sm text-muted">
            {variable}
            <input
              className="field-control selectable"
              required
              maxLength={8000}
              value={values.get(variable) ?? ''}
              onChange={(event) => setValues(new Map(values).set(variable, event.target.value))}
            />
          </label>
        ))}
        <pre className="selectable max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-canvas-deep p-4 text-ui-sm leading-relaxed text-muted">
          {text}
        </pre>
        <p className="text-ui-sm text-faint">{t('library.notice')}</p>
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={copying || variables.some((variable) => !values.get(variable)?.trim())}
          >
            <ClipboardCopy />
            {t('library.copy')}
          </Button>
        </div>
      </form>
    </LibraryDialog>
  )
}

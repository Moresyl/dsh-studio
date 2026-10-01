import { useEffect, useRef, useState } from 'react'
import { Bookmark, Pin, Save, X } from 'lucide-react'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
import { t } from '@/lib/i18n'
import { holdFocus, pressedBackdrop } from '@/lib/modal'
import type { SessionCard } from '@/lib/ipc'
import { ask } from '@/state/dialog'
import {
  annotationFor,
  emptyAnnotation,
  parseTags,
  validTags,
  sessionTitle,
  useLibrary,
} from '@/state/library'

export function SessionActions({ card }: { card: SessionCard }) {
  const item = useLibrary((state) => annotationFor(state.data.sessions, card.id))
  const disabled = useLibrary((state) => state.busy || !state.loaded)
  const annotate = useLibrary((state) => state.annotate)
  const [editing, setEditing] = useState(false)
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <IconButton
        icon={Pin}
        label={t(item?.pinned ? 'organize.unpin' : 'organize.pin')}
        aria-pressed={item?.pinned ?? false}
        disabled={disabled}
        size="xs"
        className={item?.pinned ? 'text-text' : 'text-faint'}
        onClick={() => void annotate(card.id, { pinned: !item?.pinned })}
      />
      <IconButton
        icon={Bookmark}
        label={t('organize.edit')}
        disabled={disabled}
        size="xs"
        onClick={() => setEditing(true)}
      />
      {editing && <SessionEditor card={card} onClose={() => setEditing(false)} />}
    </span>
  )
}

function SessionEditor({ card, onClose }: { card: SessionCard; onClose: () => void }) {
  const annotation =
    annotationFor(useLibrary.getState().data.sessions, card.id) ?? emptyAnnotation()
  const [title, setTitle] = useState(annotation.title)
  const [tags, setTags] = useState(annotation.tags.join(', '))
  const [note, setNote] = useState(annotation.note)
  const busy = useLibrary((state) => state.busy)
  const [confirming, setConfirming] = useState(false)
  const panel = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    useLibrary.setState({ editing: true })
    input.current?.focus()
    return () => {
      useLibrary.setState({ editing: false })
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])
  const dismiss = async () => {
    if (busy || confirming) return
    const dirty =
      title !== annotation.title || tags !== annotation.tags.join(', ') || note !== annotation.note
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
    <div
      role="presentation"
      className="dialog-backdrop fixed inset-0 z-30 grid place-items-center bg-canvas-deep/65 px-5 backdrop-blur-[2px]"
      onMouseDown={(event) => pressedBackdrop(event, () => void dismiss())}
      onKeyDown={(event) => holdFocus(panel.current, event, () => void dismiss())}
    >
      <form
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="organize-heading"
        className="dialog-panel flex max-h-[85vh] w-full max-w-[520px] flex-col gap-4 overflow-y-auto rounded-2xl border border-line-strong bg-surface p-6 shadow-lift"
        onSubmit={(event) => {
          event.preventDefault()
          if (!validTags(tags)) return
          void useLibrary
            .getState()
            .annotate(card.id, { title: title.trim(), tags: parseTags(tags), note })
            .then((saved) => {
              if (saved) onClose()
            })
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id="organize-heading" className="text-ui-lg font-semibold">
            {t('organize.edit')}
          </h2>
          <IconButton
            icon={X}
            label={t('organize.close')}
            disabled={busy}
            onClick={() => void dismiss()}
          />
        </div>
        <label className="flex flex-col gap-2 text-ui-sm text-muted">
          {t('organize.title')}
          <input
            ref={input}
            className="field-control selectable"
            maxLength={240}
            value={title}
            disabled={busy}
            placeholder={sessionTitle(card, {}) || t('sessions.untitled')}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-2 text-ui-sm text-muted">
          {t('organize.tags')}
          <input
            className="field-control selectable"
            maxLength={400}
            value={tags}
            disabled={busy}
            placeholder={t('organize.tagsHint')}
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-2 text-ui-sm text-muted">
          {t('organize.note')}
          <textarea
            className="field-control selectable min-h-32 resize-y"
            maxLength={8000}
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <p className="text-ui-sm leading-relaxed text-faint">{t('organize.notice')}</p>
        {!validTags(tags) && (
          <p role="alert" className="text-ui-sm text-danger">
            {t('organize.tagsLimit')}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => void dismiss()}>
            {t('dialog.cancel')}
          </Button>
          <Button type="submit" disabled={busy || !validTags(tags)}>
            <Save />
            {t('organize.save')}
          </Button>
        </div>
      </form>
    </div>
  )
}

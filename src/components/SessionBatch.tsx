import { useEffect, useState } from 'react'
import { Button } from '@/components/Button'
import { PersonalDialog } from '@/components/PersonalDialog'
import { Segmented } from '@/components/Segmented'
import { parseTags, validTags, useLibrary } from '@/state/library'
import { t } from '@/lib/i18n'
import { ask } from '@/state/dialog'

export function SessionBatch({
  ids,
  onClose,
  onSaved,
}: {
  ids: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [tags, setTags] = useState('')
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  const { busy, error, annotateMany } = useLibrary()
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    useLibrary.setState({ editing: true })
    return () => useLibrary.setState({ editing: false })
  }, [])
  const apply = async (patch: Parameters<typeof annotateMany>[1]) => {
    if (busy || confirming) return
    if (patch.pinned !== undefined && tags.trim()) {
      setConfirming(true)
      const confirmed = await ask({
        title: t('organize.discardTitle'),
        body: t('organize.discardBody'),
        confirm: t('organize.discard'),
        tone: 'danger',
      })
      setConfirming(false)
      if (!confirmed) return
    }
    if (await annotateMany(ids, patch)) onSaved()
  }
  const dismiss = async () => {
    if (busy || confirming) return
    setConfirming(true)
    if (
      !tags.trim() ||
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
    <PersonalDialog title={t('batch.title')} onClose={() => void dismiss()}>
      <p className="text-ui-sm text-muted">
        {t('batch.count', { count: ids.length })} · {t('batch.notice')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={busy || !ids.length}
          onClick={() => void apply({ pinned: true })}
        >
          {t('batch.pin')}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !ids.length}
          onClick={() => void apply({ pinned: false })}
        >
          {t('batch.unpin')}
        </Button>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (validTags(tags) && parseTags(tags).length)
            void apply(
              mode === 'add' ? { addTags: parseTags(tags) } : { removeTags: parseTags(tags) },
            )
        }}
      >
        <Segmented
          label={t('organize.tags')}
          value={mode}
          onChange={setMode}
          items={[
            { value: 'add', label: t('batch.addTags') },
            { value: 'remove', label: t('batch.removeTags') },
          ]}
        />
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
        {error && (
          <p role="alert" className="selectable text-ui-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => void dismiss()}>
            {t('dialog.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={busy || !ids.length || !validTags(tags) || !parseTags(tags).length}
          >
            {t(mode === 'add' ? 'batch.addTags' : 'batch.removeTags')}
          </Button>
        </div>
      </form>
    </PersonalDialog>
  )
}

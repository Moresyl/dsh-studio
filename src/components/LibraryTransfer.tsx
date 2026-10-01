import { useEffect, useRef, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { Download, Upload } from 'lucide-react'
import { Button } from '@/components/Button'
import { PersonalDialog } from '@/components/PersonalDialog'
import { Switch } from '@/components/Switch'
import { libraryExportSave, libraryImportPreview, type LibraryImportPreview } from '@/lib/ipc'
import { t } from '@/lib/i18n'
import { describe } from '@/lib/errors'
import { useLibrary } from '@/state/library'

export function LibraryTransfer({ promptsOnly = false }: { promptsOnly?: boolean }) {
  const { loaded, busy, load } = useLibrary()
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    void load()
    return () => {
      active.current = false
    }
  }, [load])
  const exportData = async () => {
    if (exporting || busy || !loaded) return
    setExporting(true)
    setStatus(null)
    useLibrary.setState({ editing: true })
    try {
      const path = await save({
        title: t(promptsOnly ? 'transfer.exportPrompts' : 'transfer.export'),
        defaultPath: promptsOnly ? 'studio-prompts.json' : 'studio-personal-data.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (!path || !active.current) return
      await libraryExportSave(path, promptsOnly)
      if (active.current) setStatus(t('transfer.saved'))
    } catch (cause) {
      if (active.current) setStatus(describe(cause))
    } finally {
      useLibrary.setState({ editing: false })
      if (active.current) setExporting(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={!loaded || busy || exporting}
        onClick={() => {
          setStatus(null)
          setImporting(true)
        }}
      >
        <Upload />
        {t(promptsOnly ? 'transfer.importPrompts' : 'transfer.restore')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={!loaded || busy || exporting}
        onClick={() => void exportData()}
      >
        <Download />
        {t(promptsOnly ? 'transfer.exportPrompts' : 'transfer.export')}
      </Button>
      {status && (
        <p role="status" className="selectable text-ui-sm text-muted">
          {status}
        </p>
      )}
      {importing && (
        <ImportReview
          promptsOnly={promptsOnly}
          onClose={(success) => {
            setImporting(false)
            if (success) setStatus(t('transfer.success'))
          }}
        />
      )}
    </div>
  )
}

function ImportReview({
  promptsOnly,
  onClose,
}: {
  promptsOnly: boolean
  onClose: (success?: boolean) => void
}) {
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<LibraryImportPreview | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useLibrary((state) => state.busy)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    useLibrary.setState({ editing: true })
    return () => {
      active.current = false
      useLibrary.setState({ editing: false })
    }
  }, [])
  const choose = async (file?: File) => {
    if (!file || reading || busy) return
    setReading(true)
    setError(null)
    setPreview(null)
    setSource('')
    setOverwrite(false)
    try {
      if (file.size > 2 * 1024 * 1024 || !file.name.toLowerCase().endsWith('.json'))
        throw new Error(t('transfer.invalid'))
      const text = await file.text()
      const next = await libraryImportPreview(text)
      if (promptsOnly && !next.promptsOnly) throw new Error(t('transfer.promptsOnly'))
      if (active.current) {
        setSource(text)
        setPreview(next)
      }
    } catch (cause) {
      if (active.current) setError(describe(cause))
    } finally {
      if (active.current) setReading(false)
    }
  }
  return (
    <PersonalDialog
      title={t(promptsOnly ? 'transfer.importPrompts' : 'transfer.restore')}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <p className="text-ui-sm leading-relaxed text-muted">{t('transfer.preview')}</p>
      <label className="flex flex-col gap-2 text-ui-sm text-muted">
        {t('transfer.select')}
        <input
          className="field-control selectable"
          type="file"
          accept=".json,application/json"
          disabled={reading || busy}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            void choose(file)
          }}
        />
      </label>
      {reading && (
        <p role="status" className="text-ui-sm text-muted">
          {t('sessions.scanning')}
        </p>
      )}
      {preview && (
        <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
          <p className="text-ui-sm">
            {t('transfer.summary', {
              prompts: preview.prompts,
              sessions: preview.sessions,
              conflicts: preview.conflicts,
            })}
          </p>
          {preview.names.length > 0 && (
            <ul className="list-inside list-disc text-ui-sm text-muted">
              {preview.names.map((name, index) => (
                <li className="truncate" key={index}>
                  {name}
                </li>
              ))}
            </ul>
          )}
          {preview.conflicts > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-ui-sm text-muted">
                {t(overwrite ? 'transfer.replace' : 'transfer.keep')}
              </span>
              <Switch
                label={t('transfer.replace')}
                on={overwrite}
                disabled={busy}
                onChange={setOverwrite}
              />
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="selectable text-ui-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => onClose()}>
          {t('dialog.cancel')}
        </Button>
        <Button
          disabled={
            !preview || reading || busy || (preview.prompts === 0 && preview.sessions === 0)
          }
          onClick={() => {
            if (!preview) return
            void useLibrary
              .getState()
              .importData(source, preview, overwrite)
              .then((success) => {
                if (!active.current) return
                if (success) onClose(true)
                else {
                  setError(useLibrary.getState().error)
                  setPreview(null)
                }
              })
          }}
        >
          {t('transfer.apply')}
        </Button>
      </div>
    </PersonalDialog>
  )
}

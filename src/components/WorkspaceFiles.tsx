import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ClipboardCopy, FileText, Folder, RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
import { PersonalDialog } from '@/components/PersonalDialog'
import { t } from '@/lib/i18n'
import { describe } from '@/lib/errors'
import { filesize, leaf } from '@/lib/format'
import {
  workspaceFileRead,
  workspaceFiles,
  type WorkspaceListing,
  type WorkspaceText,
} from '@/lib/ipc'
import { reportAction } from '@/state/failure'

export function WorkspaceFiles({ onClose }: { onClose: () => void }) {
  const [relative, setRelative] = useState('')
  const [listing, setListing] = useState<WorkspaceListing | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [text, setText] = useState<WorkspaceText | null>(null)
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const root = useRef<string | null>(null)
  useEffect(() => {
    let active = true
    void workspaceFiles(relative, root.current)
      .then((next) => {
        if (active) {
          root.current = next.root
          setListing(next)
        }
      })
      .catch((cause) => {
        if (active) {
          setError(describe(cause))
          setListing(null)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [relative, refresh])
  useEffect(() => {
    let active = true
    if (!file || !listing) return
    void workspaceFileRead(file, listing.root)
      .then((next) => {
        if (active) setText(next)
      })
      .catch((cause) => {
        if (active) setPreviewError(describe(cause))
      })
      .finally(() => {
        if (active) setReading(false)
      })
    return () => {
      active = false
    }
  }, [file, listing, retry])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])
  const parts = relative.split('/').filter(Boolean)
  const navigate = (next: string) => {
    setLoading(true)
    setError(null)
    setFile(null)
    setText(null)
    setReading(false)
    setPreviewError(null)
    setQuery('')
    setListing(null)
    if (next === relative) setRefresh((value) => value + 1)
    else setRelative(next)
  }
  const chooseFile = (next: string) => {
    setReading(true)
    setText(null)
    setPreviewError(null)
    setCopied(false)
    if (next === file) setRetry((value) => value + 1)
    else setFile(next)
  }
  const entries =
    listing?.entries.filter((entry) =>
      entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    ) ?? []
  return (
    <PersonalDialog title={t('files.title')} onClose={onClose} wide>
      <div className="flex flex-wrap items-center gap-2">
        <IconButton
          icon={ArrowLeft}
          label={t('files.parent')}
          disabled={loading || !relative}
          onClick={() => navigate(parts.slice(0, -1).join('/'))}
        />
        <nav
          aria-label={t('files.title')}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-ui-sm"
        >
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => navigate('')}>
            {t('files.root')}
          </Button>
          {parts.map((part, index) => (
            <Button
              key={index}
              variant="ghost"
              size="sm"
              className="max-w-40 min-w-0 shrink"
              disabled={loading}
              onClick={() => navigate(parts.slice(0, index + 1).join('/'))}
            >
              <span className="truncate">/ {part}</span>
            </Button>
          ))}
        </nav>
        <IconButton
          icon={RefreshCw}
          label={t('sessions.refresh')}
          disabled={loading}
          onClick={() => navigate(relative)}
        />
      </div>
      <p className="selectable truncate text-ui-sm text-faint" title={listing?.root}>
        {listing?.root}
      </p>
      <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(200px,0.8fr)_minmax(0,1.2fr)]">
        <div className="flex min-h-0 flex-col gap-3">
          <label className="field-shell">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              className="selectable"
              aria-label={t('files.filter')}
              placeholder={t('files.filter')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div
            role="region"
            aria-label={t('files.title')}
            aria-busy={loading}
            className="h-[min(43vh,420px)] overflow-y-auto rounded-xl border border-line"
          >
            {error && (
              <p role="alert" className="selectable p-4 text-ui-sm text-danger">
                {error}
              </p>
            )}
            {loading ? (
              <p role="status" className="p-4 text-ui-sm text-muted">
                {t('sessions.scanning')}
              </p>
            ) : entries.length === 0 && !error ? (
              <p className="p-4 text-ui-sm text-faint">{t('files.empty')}</p>
            ) : (
              <ul>
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      className={`flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-ui-base hover:bg-surface-2 ${file === entry.path ? 'bg-surface-2 text-text' : 'text-muted'}`}
                      aria-pressed={file === entry.path}
                      onClick={() => {
                        if (entry.directory) navigate(entry.path)
                        else chooseFile(entry.path)
                      }}
                    >
                      {entry.directory ? (
                        <Folder size={16} aria-hidden="true" />
                      ) : (
                        <FileText size={16} aria-hidden="true" />
                      )}
                      <span className="min-w-0 flex-1 truncate" title={entry.name}>
                        {entry.name}
                      </span>
                      {!entry.directory && (
                        <span className="shrink-0 text-ui-sm text-faint tabular-nums">
                          {filesize(entry.bytes)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {listing?.limited && (
            <p role="status" className="text-ui-sm text-warn">
              {t('files.limited')}
            </p>
          )}
          {!!listing?.skipped && (
            <p className="text-ui-sm text-faint">
              {t('files.skipped', { count: listing.skipped })}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-h-9 items-center gap-2">
            <h3
              className="min-w-0 flex-1 truncate text-ui-sm font-medium"
              title={file ?? undefined}
            >
              {file ? leaf(file) : t('files.preview')}
            </h3>
            {text && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void reportAction(async () => {
                    await navigator.clipboard.writeText(text.text)
                    setCopied(true)
                  })
                }
              >
                {copied ? <Check /> : <ClipboardCopy />}
                {t(copied ? 'library.copied' : 'files.copy')}
              </Button>
            )}
          </div>
          <div
            role="region"
            aria-label={t('files.preview')}
            aria-busy={reading}
            tabIndex={0}
            className="selectable h-[min(43vh,420px)] overflow-auto rounded-xl border border-line bg-canvas-deep p-4"
          >
            {reading ? (
              <p role="status" className="text-ui-sm text-muted">
                {t('sessions.scanning')}
              </p>
            ) : previewError ? (
              <div className="flex flex-col items-start gap-3">
                <p role="alert" className="text-ui-sm text-danger">
                  {previewError}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    if (file) chooseFile(file)
                  }}
                >
                  {t('sessions.refresh')}
                </Button>
              </div>
            ) : text ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-ui-sm leading-relaxed">
                {text.text}
              </pre>
            ) : (
              <p className="text-ui-sm text-faint">{t('files.choose')}</p>
            )}
          </div>
          {text && (
            <p className="text-ui-sm text-faint">
              {filesize(text.bytes)} · {t('files.lines', { count: text.lines })}
            </p>
          )}
        </div>
      </div>
      <p className="text-ui-sm leading-relaxed text-faint">{t('files.notice')}</p>
    </PersonalDialog>
  )
}

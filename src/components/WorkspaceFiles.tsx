import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ClipboardCopy,
  FileText,
  Folder,
  RefreshCw,
  Search,
  WrapText,
} from 'lucide-react'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
import { PersonalDialog } from '@/components/PersonalDialog'
import { Segmented } from '@/components/Segmented'
import { t } from '@/lib/i18n'
import { describe } from '@/lib/errors'
import { filesize, leaf } from '@/lib/format'
import { previewLines, stepFolder, visitFolder, type FileNavigation } from '@/lib/file-navigation'
import {
  workspaceFileRead,
  workspaceFiles,
  type WorkspaceListing,
  type WorkspaceText,
} from '@/lib/ipc'
import { reportAction } from '@/state/failure'

export function WorkspaceFiles({ onClose }: { onClose: () => void }) {
  const [history, setHistory] = useState<FileNavigation>({ paths: [''], cursor: 0 })
  const relative = history.paths[history.cursor] ?? ''
  const [scope, setScope] = useState<'folder' | 'workspace'>('folder')
  const [debounced, setDebounced] = useState('')
  const [wrap, setWrap] = useState(true)
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
  const [hasRoot, setHasRoot] = useState(false)
  const root = useRef<string | null>(null)
  const generation = useRef(0)
  const searchQuery = scope === 'workspace' ? debounced : ''
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 250)
    return () => window.clearTimeout(timer)
  }, [query])
  useEffect(() => {
    let active = true
    const mine = generation.current
    void workspaceFiles(
      scope === 'workspace' ? '' : relative,
      root.current,
      searchQuery.trim() ? searchQuery : null,
    )
      .then((next) => {
        if (active && mine === generation.current) {
          root.current = next.root
          setHasRoot(true)
          setListing(next)
        }
      })
      .catch((cause) => {
        if (active && mine === generation.current) {
          setError(describe(cause))
          setListing(null)
        }
      })
      .finally(() => {
        if (active && mine === generation.current) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [relative, refresh, scope, searchQuery])
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
  const clearPreview = () => {
    generation.current += 1
    setLoading(true)
    setError(null)
    setFile(null)
    setText(null)
    setReading(false)
    setPreviewError(null)
    setCopied(false)
  }
  const navigate = (next: string, restored?: FileNavigation) => {
    clearPreview()
    setScope('folder')
    setQuery('')
    setDebounced('')
    setListing(null)
    if (next === relative) setRefresh((value) => value + 1)
    setHistory(restored ?? visitFolder(history, next))
  }
  const step = (direction: -1 | 1) => {
    const next = stepFolder(history, direction)
    if (next !== history) navigate(next.paths[next.cursor] ?? '', next)
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
    scope === 'workspace'
      ? query.trim()
        ? (listing?.entries ?? [])
        : []
      : (listing?.entries.filter((entry) =>
          entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        ) ?? [])
  const searching = loading || (scope === 'workspace' && query !== debounced)
  const lines = useMemo(() => (text ? previewLines(text.text) : []), [text])
  return (
    <PersonalDialog title={t('files.title')} onClose={onClose} wide>
      <div
        className="contents"
        onKeyDown={(event) => {
          if (
            event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            ['ArrowLeft', 'ArrowRight'].includes(event.key)
          ) {
            event.preventDefault()
            step(event.key === 'ArrowLeft' ? -1 : 1)
          }
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <IconButton
            icon={ArrowLeft}
            label={t('files.back')}
            disabled={loading || history.cursor === 0}
            onClick={() => step(-1)}
          />
          <IconButton
            icon={ArrowRight}
            label={t('files.forward')}
            disabled={loading || history.cursor === history.paths.length - 1}
            onClick={() => step(1)}
          />
          <IconButton
            icon={ArrowUp}
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
            label={t('files.refresh')}
            disabled={loading}
            onClick={() => {
              clearPreview()
              setListing(null)
              setRefresh((value) => value + 1)
            }}
          />
        </div>
        <p className="selectable truncate text-ui-sm text-faint" title={listing?.root}>
          {listing?.root}
        </p>
        <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(200px,0.8fr)_minmax(0,1.2fr)]">
          <div className="flex min-h-0 flex-col gap-3">
            <Segmented
              size="sm"
              label={t('files.scope')}
              value={scope}
              items={[
                { value: 'folder', label: t('files.folderScope'), disabled: !hasRoot },
                { value: 'workspace', label: t('files.workspaceScope'), disabled: !hasRoot },
              ]}
              onChange={(next) => {
                clearPreview()
                setListing(null)
                setQuery('')
                setDebounced('')
                setScope(next)
              }}
            />
            <label className="field-shell">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                className="selectable"
                aria-label={t(scope === 'workspace' ? 'files.search' : 'files.filter')}
                placeholder={t(scope === 'workspace' ? 'files.search' : 'files.filter')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  if (scope === 'workspace') {
                    clearPreview()
                    setListing(null)
                  }
                }}
              />
            </label>
            <div
              role="region"
              aria-label={t('files.title')}
              aria-busy={searching}
              className="h-[min(43vh,420px)] overflow-y-auto rounded-xl border border-line"
            >
              {error && (
                <p role="alert" className="selectable p-4 text-ui-sm text-danger">
                  {error}
                </p>
              )}
              {searching ? (
                <p role="status" className="p-4 text-ui-sm text-muted">
                  {t('sessions.scanning')}
                </p>
              ) : entries.length === 0 && !error ? (
                <p className="p-4 text-ui-sm text-faint">
                  {t(
                    scope === 'workspace'
                      ? query.trim()
                        ? 'files.noResults'
                        : 'files.searchHint'
                      : 'files.empty',
                  )}
                </p>
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
                          {scope === 'workspace' ? entry.path : entry.name}
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
                {t(scope === 'workspace' ? 'files.searchLimited' : 'files.limited')}
              </p>
            )}
            {!!listing?.skipped && (
              <p className="text-ui-sm text-faint">
                {t('files.skipped', { count: listing.skipped })}
              </p>
            )}
            {scope === 'workspace' && query.trim() && listing && !searching && (
              <p role="status" className="text-ui-sm text-faint">
                {t('files.results', { count: entries.length, scanned: listing.scanned })}
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
                <IconButton
                  icon={WrapText}
                  label={t('files.wrap')}
                  aria-pressed={wrap}
                  onClick={() => setWrap((value) => !value)}
                />
              )}
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
                    {t('files.refresh')}
                  </Button>
                </div>
              ) : text ? (
                <div className={`file-preview ${wrap ? 'file-preview--wrap' : ''}`} dir="ltr">
                  {lines.map((line, index) => (
                    <div className="file-preview__line" key={index}>
                      <span aria-hidden="true" className="file-preview__numbers">
                        {index + 1}
                      </span>
                      <pre className="file-preview__text">{line || ' '}</pre>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-ui-sm text-faint">{t('files.choose')}</p>
              )}
            </div>
            {text && (
              <p className="text-ui-sm text-faint">
                {filesize(text.bytes)} · {t('files.lines', { count: text.lines })}
              </p>
            )}
            {text && text.lines > 5000 && (
              <p role="status" className="text-ui-sm text-warn">
                {t('files.previewLimited')}
              </p>
            )}
          </div>
        </div>
        <p className="text-ui-sm leading-relaxed text-faint">{t('files.notice')}</p>
      </div>
    </PersonalDialog>
  )
}

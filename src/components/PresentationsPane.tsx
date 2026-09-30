import { useEffect, useId, useRef, useState } from 'react'
import {
  Plus,
  Save,
  Undo2,
  Redo2,
  RefreshCw,
  FileDown,
  Copy,
  Presentation,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/Badge'
import { Button } from '@/components/Button'
import { Empty } from '@/components/Empty'
import { IconButton } from '@/components/IconButton'
import { PaneHeader } from '@/components/PaneHeader'
import { PresentationSlideView } from '@/components/PresentationSlideView'
import { Segmented } from '@/components/Segmented'
import { PresentationTemplates } from '@/components/PresentationTemplates'
import { PresentationPendingInputs } from '@/components/PresentationPendingInputs'
import { t } from '@/lib/i18n'
import { describe } from '@/lib/errors'
import { presentationList, type PresentationSummary } from '@/lib/ipc'
import { blankSlide } from '@/lib/presentation/authoring'
import type { PresentationDocument, SlideElement } from '@/lib/presentation/document'
import { savePresentationExport, type ExportPhase } from '@/lib/presentation/save-export'
import { ask } from '@/state/dialog'
import { isPresentationDirty, usePresentationEditor } from '@/state/presentation-editor'

export function PresentationsPane() {
  const editor = usePresentationEditor()
  const [library, setLibrary] = useState<PresentationSummary[]>([])
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [exportPhase, setExportPhase] = useState<ExportPhase | null>(null)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const exportJob = useRef<AbortController | null>(null)
  const propertiesHeading = useId()
  const document = editor.document
  const slide =
    document?.slides.find((item) => item.id === editor.activeSlide) ?? document?.slides[0]
  const element = slide?.elements.find((item) => item.id === selected)
  const dirty = isPresentationDirty(editor)
  const readOnly = editor.busy !== null && editor.busy !== 'save'

  useEffect(() => () => exportJob.current?.abort(), [])
  const exportPptx = async () => {
    if (!usePresentationEditor.getState().flushInputs()) return
    const source = usePresentationEditor.getState().document
    if (!source || exportJob.current) return
    const controller = new AbortController()
    exportJob.current = controller
    setExportStatus(null)
    setExportError(null)
    try {
      const saved = await savePresentationExport(source, controller.signal, setExportPhase)
      setExportStatus(t(saved ? 'deck.exported' : 'deck.exportCancelled'))
    } catch (cause) {
      if (controller.signal.aborted) setExportStatus(t('deck.exportCancelled'))
      else setExportError(describe(cause))
    } finally {
      exportJob.current = null
      setExportPhase(null)
    }
  }

  useEffect(() => {
    let active = true
    void presentationList().then(
      (items) => {
        if (active) {
          setLibrary(items)
          setLibraryError(null)
        }
      },
      (cause: unknown) => {
        if (active) setLibraryError(describe(cause))
      },
    )
    return () => {
      active = false
    }
  }, [refresh])

  const canDiscard = async () =>
    !isPresentationDirty(usePresentationEditor.getState()) ||
    (await ask({
      title: t('deck.discardTitle'),
      body: t('deck.discardBody'),
      confirm: t('deck.discard'),
      tone: 'danger',
    }))
  const create = async (source: PresentationDocument) => {
    setTemplatesOpen(false)
    if (exportJob.current) return
    if (!(await canDiscard())) return
    if (editor.replace(source, true)) {
      setSelected(null)
    }
  }
  const open = async (id: string) => {
    if (exportJob.current) return
    if (!(await canDiscard())) return
    if (await editor.open(id, true)) {
      setSelected(null)
    }
  }
  const editSlide = (change: (draft: NonNullable<typeof slide>) => void) =>
    editor.edit((draft) => {
      const target = draft.slides.find((item) => item.id === slide?.id)
      if (target) change(target)
    })
  const editElement = (change: (draft: SlideElement) => void) =>
    editSlide((draft) => {
      const target = draft.elements.find((item) => item.id === selected)
      if (target) change(target)
    })
  const insert = (kind: Exclude<SlideElement['kind'], 'image'>) => {
    const frame = { id: crypto.randomUUID(), x: 80, y: 80, width: 480, height: 160, rotation: 0 }
    const item: SlideElement =
      kind === 'text'
        ? {
            ...frame,
            kind,
            text: t('deck.text'),
            fontFace: 'Arial',
            fontSize: 28,
            color: '17202A',
            bold: false,
            italic: false,
            align: 'left',
          }
        : kind === 'shape'
          ? {
              ...frame,
              kind,
              shape: 'roundRect',
              fill: '4080C0',
              line: '306090',
              lineWidth: 0,
              opacity: 1,
            }
          : kind === 'table'
            ? {
                ...frame,
                kind,
                rows: [
                  ['A', 'B'],
                  ['1', '2'],
                ],
                fontFace: 'Arial',
                fontSize: 18,
                color: '17202A',
                fill: 'FFFFFF',
                border: 'CBD5E1',
              }
            : {
                ...frame,
                height: 320,
                kind,
                chart: 'bar',
                categories: ['A', 'B'],
                series: [{ name: t('deck.chart'), values: [10, 20] }],
                colors: ['4080C0', '20A080'],
                showLegend: true,
              }
    if (
      editSlide((draft) => {
        draft.elements.push(item)
      })
    )
      setSelected(item.id)
  }

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      inert={editor.busy === 'update' || editor.busy === 'synchronizing'}
      onKeyDown={(event) => {
        if (templatesOpen) return
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          if (event.target instanceof HTMLElement) event.target.blur()
          void editor.save().then((saved) => {
            if (saved) setRefresh((n) => n + 1)
          })
        }
      }}
    >
      <PaneHeader title={t('nav.presentations')} subtitle={t('deck.subtitle')}>
        <Button
          variant="secondary"
          disabled={!document || editor.busy !== null || exportPhase !== null}
          onClick={() => void exportPptx()}
        >
          <FileDown />
          {t('deck.export')}
        </Button>
        {exportPhase === 'generating' && (
          <Button variant="secondary" onClick={() => exportJob.current?.abort()}>
            {t('deck.cancelExport')}
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => setTemplatesOpen(true)}
          disabled={editor.busy !== null || exportPhase !== null}
        >
          <Plus />
          {t('deck.new')}
        </Button>
        <IconButton
          variant="secondary"
          icon={Undo2}
          label={t('deck.undo')}
          onClick={editor.undo}
          disabled={!editor.past.length || readOnly}
        />
        <IconButton
          variant="secondary"
          icon={Redo2}
          label={t('deck.redo')}
          onClick={editor.redo}
          disabled={!editor.future.length || readOnly}
        />
        {/* The pane's one primary, and it only lights up while there is something to
            save. Ctrl+S is unchanged: it still writes a clean deck if asked. */}
        <Button
          variant="primary"
          disabled={!document || editor.busy !== null || !dirty}
          onClick={() =>
            void editor.save().then((saved) => {
              if (saved) setRefresh((n) => n + 1)
            })
          }
        >
          <Save />
          {t('deck.save')}
        </Button>
        <Button
          variant="secondary"
          disabled={!document || editor.busy !== null || exportPhase !== null}
          title={t('deck.saveCopyHint')}
          onClick={() =>
            void editor.saveCopy(t('deck.copySuffix')).then((saved) => {
              if (saved) {
                setSelected(null)
                setRefresh((n) => n + 1)
              }
            })
          }
        >
          <Copy />
          {t('deck.saveCopy')}
        </Button>
      </PaneHeader>
      <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
        {/* Same measure as the header above it, so the rail lines up under the title and
            the properties card ends under the last button. Each column scrolls by
            itself: a twenty-slide deck must not carry the canvas out of view. */}
        <div className="mx-auto flex min-h-0 w-full max-w-[1040px] flex-1 gap-4">
          {/* The 4px gutter (padding, cancelled by the margin) is where the rows' and
              tiles' focus rings are drawn, so the scroll container does not clip them. */}
          <aside
            className="-m-1 flex w-42 shrink-0 flex-col gap-3 overflow-y-auto p-1"
            aria-label={t('deck.library')}
          >
            <section className="flex flex-col gap-0.5">
              <div className="mb-1 flex items-center justify-between pl-2.5">
                <h2 className="caption">{t('deck.library')}</h2>
                <IconButton
                  size="xs"
                  label={t('deck.refresh')}
                  icon={RefreshCw}
                  onClick={() => setRefresh((n) => n + 1)}
                />
              </div>
              {library.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={editor.busy !== null || exportPhase !== null}
                  onClick={() => void open(item.id)}
                  aria-pressed={document?.id === item.id}
                  className={[
                    'block h-9 w-full truncate rounded-lg px-2.5 text-left text-ui-base transition-colors',
                    document?.id === item.id
                      ? 'bg-surface-2 font-medium text-text'
                      : 'text-muted enabled:hover:bg-surface-2/70 enabled:hover:text-text',
                  ].join(' ')}
                  title={item.title ?? item.id}
                >
                  {item.title ?? t('deck.unreadable')}
                </button>
              ))}
            </section>
            {document && (
              <div className="flex flex-col gap-2 border-t border-line pt-3">
                {document.slides.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      editor.selectSlide(item.id)
                      setSelected(null)
                    }}
                    aria-pressed={slide?.id === item.id}
                    className={[
                      'block w-full rounded-lg border p-1.5 text-left transition-colors',
                      slide?.id === item.id
                        ? 'border-brand bg-surface-2'
                        : 'border-line hover:bg-surface-2/70',
                    ].join(' ')}
                  >
                    <PresentationSlideView slide={item} aspect={document.aspect} />
                    <span className="mt-1.5 block truncate text-ui-xs text-muted">
                      {t('deck.slide', { number: index + 1 })} · {item.title}
                    </span>
                  </button>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  disabled={document.slides.length >= 100 || readOnly}
                  onClick={() => {
                    const next = blankSlide(t('deck.slide', { number: document.slides.length + 1 }))
                    if (
                      editor.edit((draft) => {
                        draft.slides.push(next)
                      })
                    ) {
                      editor.selectSlide(next.id)
                      setSelected(null)
                    }
                  }}
                >
                  <Plus />
                  {t('deck.addSlide')}
                </Button>
              </div>
            )}
          </aside>
          {/* The container the editor's own breakpoint is measured against: side by side
              once the canvas keeps at least ~300px next to the 256px properties card,
              stacked (and scrolling as one) below that. */}
          <div className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            {(exportPhase || exportStatus || exportError || editor.error || libraryError) && (
              <div className="shrink-0 space-y-3">
                {(exportPhase || exportStatus) && (
                  <p role="status" className="text-ui-sm text-muted">
                    {exportPhase ? t(`deck.export.${exportPhase}`) : exportStatus}
                  </p>
                )}
                {exportError && (
                  <p
                    role="alert"
                    className="selectable rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger"
                  >
                    {exportError}
                  </p>
                )}
                {(editor.error || libraryError) && (
                  <p
                    role="alert"
                    className="selectable rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger"
                  >
                    {editor.error ?? libraryError}
                  </p>
                )}
                {editor.error && <PresentationPendingInputs />}
              </div>
            )}
            {!document || !slide ? (
              <div className="card min-h-0 flex-1">
                <Empty icon={Presentation} message={t('deck.empty')} />
              </div>
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {(['text', 'shape', 'table', 'chart'] as const).map((kind) => (
                    <Button
                      key={kind}
                      variant="secondary"
                      size="sm"
                      disabled={readOnly || slide.elements.length >= 200}
                      onClick={() => insert(kind)}
                    >
                      <Plus />
                      {t(`deck.${kind}`)}
                    </Button>
                  ))}
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={editor.busy !== null || slide.elements.length >= 200}
                    onClick={() =>
                      void editor.insertImage(slide.id).then((id) => {
                        if (id) setSelected(id)
                      })
                    }
                  >
                    <Plus />
                    {t('deck.image')}
                  </Button>
                  <Badge
                    role="status"
                    tone={editor.busy ? 'neutral' : dirty ? 'warn' : 'ok'}
                    className="ml-auto"
                  >
                    {editor.busy ? t('deck.busy') : dirty ? t('deck.unsaved') : t('deck.saved')}
                  </Badge>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto @xl:flex-row @xl:overflow-visible">
                  <div className="flex min-w-0 flex-col gap-4 @xl:min-h-0 @xl:flex-1 @xl:overflow-y-auto">
                    <PresentationSlideView
                      slide={slide}
                      aspect={document.aspect}
                      selected={selected}
                      onSelect={setSelected}
                      onMove={
                        readOnly
                          ? undefined
                          : (id, position) =>
                              editSlide((draft) => {
                                const target = draft.elements.find((item) => item.id === id)
                                if (target) Object.assign(target, position)
                              })
                      }
                    />
                    <ValueField
                      fieldKey={`${document.id}/${slide.id}/notes`}
                      key={`${slide.id}-notes`}
                      label={t('deck.notes')}
                      value={slide.notes}
                      multiline
                      commit={(value) =>
                        editSlide((draft) => {
                          draft.notes = value
                        })
                      }
                    />
                  </div>
                  {/* Still a fieldset: `disabled` on it is what locks every field and button
                      inside while the editor is busy. Its border and legend are gone; the
                      card and the heading take their place. */}
                  <fieldset
                    aria-labelledby={propertiesHeading}
                    disabled={readOnly}
                    className="card min-w-0 p-4 @xl:max-h-full @xl:w-64 @xl:shrink-0 @xl:self-start @xl:overflow-y-auto"
                  >
                    <h2 id={propertiesHeading} className="caption mb-3">
                      {t('deck.properties')}
                    </h2>
                    <div className="flex flex-col gap-4">
                      <ValueField
                        fieldKey={`${document.id}/title`}
                        label={t('deck.title')}
                        value={document.title}
                        commit={(value) =>
                          editor.edit((draft) => {
                            draft.title = value
                          })
                        }
                      />
                      <ValueField
                        fieldKey={`${document.id}/${slide.id}/title`}
                        label={t('deck.slideTitle')}
                        value={slide.title}
                        commit={(value) =>
                          editSlide((draft) => {
                            draft.title = value
                          })
                        }
                      />
                      <ColorField
                        label={t('deck.background')}
                        value={slide.background}
                        commit={(value) =>
                          editSlide((draft) => {
                            draft.background = value
                          })
                        }
                      />
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        className="-ml-2.5 self-start"
                        disabled={document.slides.length <= 1}
                        onClick={() => {
                          if (
                            editor.edit((draft) => {
                              draft.slides = draft.slides.filter((item) => item.id !== slide.id)
                            })
                          ) {
                            setSelected(null)
                          }
                        }}
                      >
                        <Trash2 />
                        {t('deck.removeSlide')}
                      </Button>
                      {element ? (
                        <div
                          key={element.id}
                          className="flex flex-col gap-4 border-t border-line pt-4"
                        >
                          <div className="grid grid-cols-2 gap-x-2 gap-y-3">
                            {(['x', 'y', 'width', 'height'] as const).map((key) => (
                              <ValueField
                                fieldKey={`${document.id}/${slide.id}/${element.id}/${key}`}
                                key={key}
                                dense
                                label={t(`deck.${key}`)}
                                value={String(element[key])}
                                numeric
                                commit={(value) =>
                                  editElement((draft) => {
                                    draft[key] = Number(value)
                                  })
                                }
                              />
                            ))}
                          </div>
                          {element.kind === 'text' && (
                            <ValueField
                              fieldKey={`${document.id}/${slide.id}/${element.id}/text`}
                              label={t('deck.text')}
                              value={element.text}
                              multiline
                              commit={(value) =>
                                editElement((draft) => {
                                  if (draft.kind === 'text') draft.text = value
                                })
                              }
                            />
                          )}
                          {element.kind === 'image' && (
                            <>
                              <ValueField
                                fieldKey={`${document.id}/${slide.id}/${element.id}/alt`}
                                label={t('deck.imageAlt')}
                                value={element.alt}
                                commit={(value) =>
                                  editElement((draft) => {
                                    if (draft.kind === 'image') draft.alt = value
                                  })
                                }
                              />
                              <div>
                                {/* The group below is named for assistive tech; this is its
                                    visible caption. */}
                                <span className="field-label" aria-hidden="true">
                                  {t('deck.imageFit')}
                                </span>
                                <Segmented
                                  size="sm"
                                  label={t('deck.imageFit')}
                                  value={element.fit}
                                  onChange={(fit) =>
                                    editElement((draft) => {
                                      if (draft.kind === 'image') draft.fit = fit
                                    })
                                  }
                                  items={(['contain', 'cover', 'stretch'] as const).map((fit) => ({
                                    value: fit,
                                    label: t(`deck.imageFit.${fit}`),
                                  }))}
                                />
                              </div>
                            </>
                          )}
                          {(element.kind === 'text' || element.kind === 'table') && (
                            <>
                              <ValueField
                                fieldKey={`${document.id}/${slide.id}/${element.id}/fontSize`}
                                layout="inline"
                                label={t('deck.fontSize')}
                                value={String(element.fontSize)}
                                numeric
                                commit={(value) =>
                                  editElement((draft) => {
                                    if (draft.kind === 'text' || draft.kind === 'table')
                                      draft.fontSize = Number(value)
                                  })
                                }
                              />
                              <ColorField
                                label={t('deck.color')}
                                value={element.color}
                                commit={(value) =>
                                  editElement((draft) => {
                                    if (draft.kind === 'text' || draft.kind === 'table')
                                      draft.color = value
                                  })
                                }
                              />
                            </>
                          )}
                          {element.kind === 'shape' && (
                            <ColorField
                              label={t('deck.fill')}
                              value={element.fill}
                              commit={(value) =>
                                editElement((draft) => {
                                  if (draft.kind === 'shape') draft.fill = value
                                })
                              }
                            />
                          )}
                          {element.kind === 'table' && (
                            <div className="flex flex-col gap-1.5">
                              {element.rows.map((row, rowIndex) => (
                                <div
                                  key={rowIndex}
                                  className="grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-1.5"
                                >
                                  {row.map((cell, column) => (
                                    <ValueField
                                      fieldKey={`${document.id}/${slide.id}/${element.id}/cell/${rowIndex}/${column}`}
                                      key={column}
                                      dense
                                      layout="bare"
                                      label={`${rowIndex + 1} · ${column + 1}`}
                                      value={cell}
                                      commit={(value) =>
                                        editElement((draft) => {
                                          if (draft.kind === 'table')
                                            draft.rows[rowIndex]![column] = value
                                        })
                                      }
                                    />
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                          {element.kind === 'chart' && (
                            <div className="flex flex-col gap-3">
                              {element.categories.map((category, index) => (
                                <div
                                  key={index}
                                  className="grid grid-cols-[repeat(auto-fit,minmax(4.5rem,1fr))] gap-x-2 gap-y-1.5"
                                >
                                  <ValueField
                                    fieldKey={`${document.id}/${slide.id}/${element.id}/category/${index}`}
                                    dense
                                    label={`${t('deck.chart')} ${index + 1}`}
                                    value={category}
                                    commit={(value) =>
                                      editElement((draft) => {
                                        if (draft.kind === 'chart') draft.categories[index] = value
                                      })
                                    }
                                  />
                                  {element.series.map((series, seriesIndex) => (
                                    <ValueField
                                      fieldKey={`${document.id}/${slide.id}/${element.id}/series/${seriesIndex}/${index}`}
                                      key={seriesIndex}
                                      dense
                                      label={series.name}
                                      numeric
                                      value={String(series.values[index])}
                                      commit={(value) =>
                                        editElement((draft) => {
                                          if (draft.kind === 'chart')
                                            draft.series[seriesIndex]!.values[index] = Number(value)
                                        })
                                      }
                                    />
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            className="-ml-2.5 self-start"
                            onClick={() => {
                              if (
                                editSlide((draft) => {
                                  draft.elements = draft.elements.filter(
                                    (item) => item.id !== selected,
                                  )
                                })
                              )
                                setSelected(null)
                            }}
                          >
                            <Trash2 />
                            {t('deck.remove')}
                          </Button>
                        </div>
                      ) : (
                        <p className="border-t border-line pt-4 text-ui-sm text-faint">
                          {t('deck.select')}
                        </p>
                      )}
                    </div>
                  </fieldset>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {templatesOpen && (
        <PresentationTemplates
          onClose={() => setTemplatesOpen(false)}
          onCreate={(source) => void create(source)}
        />
      )}
    </section>
  )
}

function ValueField({
  fieldKey,
  label,
  value,
  multiline,
  numeric,
  dense,
  layout = 'stacked',
  commit,
}: {
  fieldKey: string
  label: string
  value: string
  multiline?: boolean
  numeric?: boolean
  /** The 28px field, for grids of numbers and table cells. */
  dense?: boolean
  /** Where the label sits: above the field, beside it, or for assistive tech only. */
  layout?: 'stacked' | 'inline' | 'bare'
  commit: (value: string) => boolean
}) {
  const pending = usePresentationEditor((state) => state.inputs[fieldKey])
  const apply = () => usePresentationEditor.getState().commitInput(fieldKey)
  const common = {
    className: [
      'field-control min-w-0',
      layout === 'inline' ? 'w-20 shrink-0' : 'w-full',
      dense && 'field-control--sm',
      multiline && 'min-h-20 resize-y',
    ]
      .filter(Boolean)
      .join(' '),
    value: pending?.value ?? value,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = event.target.value
      const editor = usePresentationEditor.getState()
      if (next === value) editor.discardInput(fieldKey)
      else
        editor.stageInput(fieldKey, {
          value: next,
          label,
          commit: (input) => (!numeric || input.trim() !== '') && commit(input),
        })
    },
    onBlur: apply,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Enter' && !multiline) {
        event.preventDefault()
        event.currentTarget.blur()
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        usePresentationEditor.getState().discardInput(fieldKey)
      }
    },
  }
  return (
    <label
      className={
        layout === 'inline'
          ? 'flex min-w-0 items-center justify-between gap-3'
          : 'block min-w-0'
      }
    >
      <span
        className={
          layout === 'inline'
            ? 'field-label mb-0 truncate'
            : layout === 'bare'
              ? 'sr-only'
              : 'field-label'
        }
      >
        {label}
      </span>
      {multiline ? (
        <textarea {...common} aria-label={label} rows={3} />
      ) : (
        <input {...common} aria-label={label} type={numeric ? 'number' : 'text'} />
      )}
    </label>
  )
}

function ColorField({
  label,
  value,
  commit,
}: {
  label: string
  value: string
  commit: (value: string) => boolean
}) {
  return (
    <label className="flex min-w-0 items-center justify-between gap-3">
      <span className="field-label mb-0 truncate">{label}</span>
      <input
        type="color"
        value={`#${value}`}
        aria-label={label}
        onChange={(event) => commit(event.target.value.slice(1))}
        className="field-control w-14 shrink-0"
      />
    </label>
  )
}

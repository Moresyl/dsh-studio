import { useEffect, useRef, useState } from 'react'
import { Plus, Save, Undo2, Redo2, RefreshCw, FileDown, Copy } from 'lucide-react'
import { Button } from '@/components/Button'
import { PaneHeader } from '@/components/PaneHeader'
import { PresentationSlideView } from '@/components/PresentationSlideView'
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
          <FileDown size={13} />
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
          <Plus size={13} />
          {t('deck.new')}
        </Button>
        <Button
          variant="secondary"
          onClick={editor.undo}
          disabled={!editor.past.length || readOnly}
          aria-label={t('deck.undo')}
        >
          <Undo2 size={13} />
        </Button>
        <Button
          variant="secondary"
          onClick={editor.redo}
          disabled={!editor.future.length || readOnly}
          aria-label={t('deck.redo')}
        >
          <Redo2 size={13} />
        </Button>
        <Button
          disabled={!document || editor.busy !== null}
          onClick={() =>
            void editor.save().then((saved) => {
              if (saved) setRefresh((n) => n + 1)
            })
          }
        >
          <Save size={13} />
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
          <Copy size={13} />
          {t('deck.saveCopy')}
        </Button>
      </PaneHeader>
      <div className="flex min-h-0 flex-1 gap-4 overflow-y-auto px-6 pb-6">
        <aside className="w-[144px] shrink-0 space-y-3" aria-label={t('deck.library')}>
          <div className="flex items-center justify-between text-[12px] text-muted">
            <span>{t('deck.library')}</span>
            <Button
              variant="ghost"
              aria-label={t('deck.refresh')}
              onClick={() => setRefresh((n) => n + 1)}
            >
              <RefreshCw size={12} />
            </Button>
          </div>
          {library.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={editor.busy !== null || exportPhase !== null}
              onClick={() => void open(item.id)}
              aria-pressed={document?.id === item.id}
              className="block w-full truncate rounded-control px-2 py-2 text-left text-[12px] text-muted hover:bg-control-fill aria-pressed:bg-control-fill aria-pressed:text-text"
              title={item.title ?? item.id}
            >
              {item.title ?? t('deck.unreadable')}
            </button>
          ))}
          {document && (
            <div className="space-y-3 border-t border-line pt-3">
              {document.slides.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    editor.selectSlide(item.id)
                    setSelected(null)
                  }}
                  aria-pressed={slide?.id === item.id}
                  className="block w-full rounded-control border border-line p-1.5 text-left aria-pressed:border-brand"
                >
                  <PresentationSlideView slide={item} aspect={document.aspect} />
                  <span className="mt-1 block truncate text-[11px] text-muted">
                    {t('deck.slide', { number: index + 1 })} · {item.title}
                  </span>
                </button>
              ))}
              <Button
                variant="secondary"
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
                {t('deck.addSlide')}
              </Button>
            </div>
          )}
        </aside>
        <div className="min-w-0 flex-1 space-y-3">
          {(exportPhase || exportStatus) && (
            <p role="status" className="text-[12px] text-muted">
              {exportPhase ? t(`deck.export.${exportPhase}`) : exportStatus}
            </p>
          )}
          {exportError && (
            <p
              role="alert"
              className="selectable rounded-control border border-danger/30 px-3 py-2 text-[12px] text-danger"
            >
              {exportError}
            </p>
          )}
          {(editor.error || libraryError) && (
            <p
              role="alert"
              className="selectable rounded-control border border-danger/30 px-3 py-2 text-[12px] text-danger"
            >
              {editor.error ?? libraryError}
            </p>
          )}
          {editor.error && <PresentationPendingInputs />}
          {!document || !slide ? (
            <p className="p-8 text-[13px] text-muted">{t('deck.empty')}</p>
          ) : (
            <>
              <p role="status" className="text-[12px] text-muted">
                {editor.busy ? t('deck.busy') : dirty ? t('deck.unsaved') : t('deck.saved')}
              </p>
              <div className="flex flex-wrap gap-4">
                <div className="min-w-0 flex-[1_1_320px] space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {(['text', 'shape', 'table', 'chart'] as const).map((kind) => (
                      <Button
                        key={kind}
                        variant="secondary"
                        disabled={readOnly || slide.elements.length >= 200}
                        onClick={() => insert(kind)}
                      >
                        <Plus size={12} />
                        {t(`deck.${kind}`)}
                      </Button>
                    ))}
                    <Button
                      variant="secondary"
                      disabled={editor.busy !== null || slide.elements.length >= 200}
                      onClick={() =>
                        void editor.insertImage(slide.id).then((id) => {
                          if (id) setSelected(id)
                        })
                      }
                    >
                      <Plus size={12} />
                      {t('deck.image')}
                    </Button>
                  </div>
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
                <fieldset
                  disabled={readOnly}
                  className="max-h-[calc(100vh-180px)] min-w-0 flex-[1_1_220px] space-y-3 overflow-y-auto rounded-panel border border-line p-3"
                >
                  <legend className="px-1 text-[12px] text-muted">{t('deck.properties')}</legend>
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
                    variant="secondary"
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
                    {t('deck.removeSlide')}
                  </Button>
                  {element ? (
                    <div key={element.id} className="space-y-3 border-t border-line pt-3">
                      {(['x', 'y', 'width', 'height'] as const).map((key) => (
                        <ValueField
                          fieldKey={`${document.id}/${slide.id}/${element.id}/${key}`}
                          key={key}
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
                          <div
                            className="flex flex-wrap gap-1"
                            role="group"
                            aria-label={t('deck.imageFit')}
                          >
                            {(['contain', 'cover', 'stretch'] as const).map((fit) => (
                              <Button
                                key={fit}
                                variant="secondary"
                                aria-pressed={element.fit === fit}
                                onClick={() =>
                                  editElement((draft) => {
                                    if (draft.kind === 'image') draft.fit = fit
                                  })
                                }
                              >
                                {t(`deck.imageFit.${fit}`)}
                              </Button>
                            ))}
                          </div>
                        </>
                      )}
                      {(element.kind === 'text' || element.kind === 'table') && (
                        <>
                          <ValueField
                            fieldKey={`${document.id}/${slide.id}/${element.id}/fontSize`}
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
                      {element.kind === 'table' &&
                        element.rows.map((row, rowIndex) => (
                          <div key={rowIndex} className="flex gap-1">
                            {row.map((cell, column) => (
                              <ValueField
                                fieldKey={`${document.id}/${slide.id}/${element.id}/cell/${rowIndex}/${column}`}
                                key={column}
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
                      {element.kind === 'chart' &&
                        element.categories.map((category, index) => (
                          <div key={index} className="space-y-1">
                            <ValueField
                              fieldKey={`${document.id}/${slide.id}/${element.id}/category/${index}`}
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
                      <Button
                        variant="secondary"
                        onClick={() => {
                          if (
                            editSlide((draft) => {
                              draft.elements = draft.elements.filter((item) => item.id !== selected)
                            })
                          )
                            setSelected(null)
                        }}
                      >
                        {t('deck.remove')}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-[12px] text-muted">{t('deck.select')}</p>
                  )}
                </fieldset>
              </div>
            </>
          )}
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
  commit,
}: {
  fieldKey: string
  label: string
  value: string
  multiline?: boolean
  numeric?: boolean
  commit: (value: string) => boolean
}) {
  const pending = usePresentationEditor((state) => state.inputs[fieldKey])
  const apply = () => usePresentationEditor.getState().commitInput(fieldKey)
  const common = {
    className: 'field-control w-full min-w-0',
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
    <label className="block min-w-0 flex-1 space-y-1 text-[11px] text-muted">
      <span>{label}</span>
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
    <label className="flex items-center justify-between text-[11px] text-muted">
      <span>{label}</span>
      <input
        type="color"
        value={`#${value}`}
        aria-label={label}
        onChange={(event) => commit(event.target.value.slice(1))}
        className="h-6 w-10 cursor-pointer rounded-control border border-line bg-transparent"
      />
    </label>
  )
}

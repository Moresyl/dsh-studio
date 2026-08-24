import { useEffect, useState } from 'react'
import type { ComponentType, KeyboardEvent, ReactNode } from 'react'
import {
  BellRing,
  CircleCheck,
  CircleX,
  Keyboard,
  Network,
  Power,
  PanelsTopLeft,
  ScrollText,
  SunMoon,
  TriangleAlert,
  X,
} from 'lucide-react'

import { Button } from '@/components/Button'
import { PaneHeader } from '@/components/PaneHeader'
import { Switch } from '@/components/Switch'
import { ThemeSwitch } from '@/components/ThemeSwitch'
import { t } from '@/lib/i18n'
import { readCombination, spellCombination } from '@/lib/keys'
import { isMac } from '@/lib/platform'
import { useStartup } from '@/state/startup'
import { usePresentation } from '@/state/presentation'

/**
 * Settings that outlive the window.
 *
 * Everything else this app can be told is a property of a profile, a session or
 * a plugin, and lives next to the thing it changes. What is left is the handful
 * of facts about the machine rather than the work: whether the app is here at
 * login, which key reaches it from anywhere, and which palette it paints. So
 * this pane is deliberately short, and it stays short — a settings screen that
 * collects every switch in the app is the place options go to be lost.
 *
 * The first two are off until asked for. A login item nobody agreed to is the
 * reason people distrust installers, and a global key is taken away from every
 * other program on the machine, including the editor that had it first.
 */
export function SettingsPane() {
  const state = useStartup((store) => store.state)
  const busy = useStartup((store) => store.busy)
  const error = useStartup((store) => store.error)
  const refresh = useStartup((store) => store.refresh)
  const setAutostart = useStartup((store) => store.setAutostart)
  const setNotification = useStartup((store) => store.setNotification)
  const testNotification = useStartup((store) => store.testNotification)
  const setLogLevel = useStartup((store) => store.setLogLevel)
  const setHarnessPort = useStartup((store) => store.setHarnessPort)
  const retry = useStartup((store) => store.retry)
  const presentation = usePresentation((store) => store.mode)
  const choosePresentation = usePresentation((store) => store.choose)

  // Asked again on every visit rather than once at launch: both of these can be
  // taken away from outside the app — the login item from Task Manager, the key
  // by whatever started next — and this pane is where somebody comes to look.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Held here rather than inside the recorder because the way out of it belongs
  // under the label, where there is room for a sentence — a button in the middle
  // of listening for a keystroke is the last place to explain itself.
  const [recording, setRecording] = useState(false)

  const ready = state !== null
  const occupied = Boolean(state?.shortcut) && state?.held === false

  return (
    <section className="flex min-h-0 flex-1 animate-rise flex-col">
      <PaneHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas px-6 py-6">
        <div className="mx-auto flex max-w-[620px] flex-col gap-4">
          <div className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-canvas-deep/50">
            <Row icon={Power} label={t('settings.autostart')} hint={t('settings.autostartHint')}>
              <Switch
                on={state?.autostart ?? false}
                busy={busy}
                disabled={!ready}
                label={t('settings.autostart')}
                onChange={(on) => void setAutostart(on)}
              />
            </Row>

            <Row
              icon={Keyboard}
              label={t('settings.shortcut')}
              hint={t('settings.shortcutHint')}
              note={
                recording ? (
                  <span className="text-brand">{t('settings.recordingHint')}</span>
                ) : (
                  occupied && (
                    <span className="flex items-center gap-2 text-warn">
                      <TriangleAlert size={12} strokeWidth={2.2} aria-hidden="true" />
                      {t('settings.taken')}
                      <button
                        type="button"
                        onClick={() => void retry()}
                        disabled={busy}
                        className="shrink-0 font-medium underline decoration-warn/40 underline-offset-2 transition-colors duration-100 enabled:hover:decoration-warn"
                      >
                        {t('settings.retake')}
                      </button>
                    </span>
                  )
                )
              }
            >
              <Recorder recording={recording} onRecording={setRecording} />
            </Row>

            <Row
              icon={SunMoon}
              label={t('settings.appearance')}
              hint={t('settings.appearanceHint')}
            >
              <ThemeSwitch />
            </Row>

            <Row
              icon={PanelsTopLeft}
              label={t('settings.presentation')}
              hint={t('settings.presentationHint')}
            >
              <select
                value={presentation}
                aria-label={t('settings.presentation')}
                onChange={(event) =>
                  choosePresentation(
                    event.target.value as 'compatibility' | 'extended' | 'advanced',
                  )
                }
                className="h-[30px] rounded-control border border-line-strong bg-surface-2 px-2.5 text-[11.5px] text-text outline-none focus:border-brand"
              >
                <option value="compatibility">{t('settings.presentation.compatibility')}</option>
                <option value="extended">{t('settings.presentation.extended')}</option>
                <option value="advanced">{t('settings.presentation.advanced')}</option>
              </select>
            </Row>

            <Row icon={ScrollText} label={t('settings.logLevel')} hint={t('settings.logLevelHint')}>
              <select
                value={state?.logLevel ?? 'info'}
                aria-label={t('settings.logLevel')}
                disabled={!ready || busy}
                onChange={(event) =>
                  void setLogLevel(event.target.value as 'debug' | 'info' | 'warn' | 'error')
                }
                className="h-[30px] rounded-control border border-line-strong bg-surface-2 px-2.5 text-[11.5px] text-text outline-none focus:border-brand disabled:opacity-40"
              >
                <option value="debug">{t('settings.logLevel.debug')}</option>
                <option value="info">{t('settings.logLevel.info')}</option>
                <option value="warn">{t('settings.logLevel.warn')}</option>
                <option value="error">{t('settings.logLevel.error')}</option>
              </select>
            </Row>

            <Row
              icon={Network}
              label={t('settings.harnessPort')}
              hint={t('settings.harnessPortHint')}
            >
              <PortField
                key={state?.harnessPort ?? 'automatic'}
                value={state?.harnessPort ?? null}
                disabled={!ready || busy}
                onSave={(port) => void setHarnessPort(port)}
              />
            </Row>

            <Row
              icon={BellRing}
              label={t('settings.turnCompleted')}
              hint={t('settings.turnCompletedHint')}
            >
              <Switch
                on={state?.notifications.turnCompleted ?? true}
                busy={busy}
                disabled={!ready}
                label={t('settings.turnCompleted')}
                onChange={(on) => void setNotification('turn-completed', on)}
              />
            </Row>

            <Row
              icon={CircleX}
              label={t('settings.turnFailed')}
              hint={t('settings.turnFailedHint')}
            >
              <Switch
                on={state?.notifications.turnFailed ?? true}
                busy={busy}
                disabled={!ready}
                label={t('settings.turnFailed')}
                onChange={(on) => void setNotification('turn-failed', on)}
              />
            </Row>

            <Row
              icon={CircleCheck}
              label={t('settings.jobCompleted')}
              hint={t('settings.jobCompletedHint')}
            >
              <Switch
                on={state?.notifications.jobCompleted ?? true}
                busy={busy}
                disabled={!ready}
                label={t('settings.jobCompleted')}
                onChange={(on) => void setNotification('job-completed', on)}
              />
            </Row>

            <Row
              icon={TriangleAlert}
              label={t('settings.jobFailed')}
              hint={t('settings.jobFailedHint')}
            >
              <Switch
                on={state?.notifications.jobFailed ?? true}
                busy={busy}
                disabled={!ready}
                label={t('settings.jobFailed')}
                onChange={(on) => void setNotification('job-failed', on)}
              />
            </Row>

            <Row
              icon={BellRing}
              label={t('settings.notificationTest')}
              hint={t('settings.notificationTestHint')}
            >
              <Button
                variant="secondary"
                className="h-[30px] px-2.5 text-[11.5px]"
                disabled={!ready || busy}
                onClick={() => void testNotification()}
              >
                {t('settings.notificationTestAction')}
              </Button>
            </Row>
          </div>

          {error && (
            <p className="selectable rounded-control border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] leading-relaxed text-danger">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * The combination itself, which is also the control that changes it.
 *
 * Pressing the keys is the only way to say which keys, so the display and the
 * recorder are one button rather than a readout with a "change" beside it — the
 * thing on screen is the shortcut, and pressing it is how you replace it.
 */
interface RecorderProps {
  recording: boolean
  onRecording: (recording: boolean) => void
}

function Recorder({ recording, onRecording: setRecording }: RecorderProps) {
  const state = useStartup((store) => store.state)
  const busy = useStartup((store) => store.busy)
  const setShortcut = useStartup((store) => store.setShortcut)

  const held = state?.shortcut ?? null
  const keys = held ? spellCombination(held, isMac) : []

  const capture = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Held before anything is read. While this button has the keyboard it has
    // all of it: the window listeners in `App.tsx` and `native.ts` would
    // otherwise answer the very combination being recorded, and the webview
    // would act on whatever it recognises.
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat) return

    // Checked ahead of the rest so Ctrl+Escape is a way out and not a choice.
    if (event.code === 'Escape') {
      setRecording(false)
      return
    }

    // Null while only modifiers are down, and null for a combination Rust would
    // refuse — either way there is nothing yet, so the button keeps listening.
    const combination = readCombination(event)
    if (!combination) return

    setRecording(false)
    void setShortcut(combination)
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={busy || state === null}
        data-hint={recording ? undefined : t('settings.record')}
        onClick={(event) => {
          // Focused by hand because a click does not focus a button on every
          // platform, and a recorder that is not focused hears nothing.
          event.currentTarget.focus()
          setRecording(true)
        }}
        onKeyDown={recording ? capture : undefined}
        onBlur={() => setRecording(false)}
        className={[
          'flex h-[30px] min-w-[152px] items-center justify-center gap-1 rounded-control border px-2.5 text-[12px] transition duration-100 ease-[var(--ease-out-soft)] select-none disabled:opacity-40',
          recording
            ? 'border-brand bg-brand/10 text-brand'
            : 'border-line-strong bg-surface-2 text-text enabled:hover:brightness-[1.15] enabled:active:brightness-95',
        ].join(' ')}
      >
        {recording ? (
          t('settings.recording')
        ) : keys.length > 0 ? (
          <Chips keys={keys} />
        ) : (
          <span className="text-muted">{t('settings.none')}</span>
        )}
      </button>

      {!recording &&
        (held ? (
          <Button
            variant="ghost"
            disabled={busy}
            aria-label={t('settings.clear')}
            data-hint={t('settings.clear')}
            onClick={() => void setShortcut(null)}
          >
            <X size={13} strokeWidth={2.3} aria-hidden="true" />
          </Button>
        ) : (
          // Offered rather than applied. Somebody who wants a global key almost
          // never has an opinion about which one, and inventing a combination
          // that nothing else on the machine has taken is the tedious half of
          // this setting — but taking a key without being asked is the rude half.
          state && (
            <Button
              variant="ghost"
              disabled={busy}
              aria-label={t('settings.suggest', {
                keys: spellCombination(state.suggested, isMac).join(' '),
              })}
              data-hint={t('settings.suggest', {
                keys: spellCombination(state.suggested, isMac).join(' '),
              })}
              onClick={() => void setShortcut(state.suggested)}
            >
              <Chips keys={spellCombination(state.suggested, isMac)} />
            </Button>
          )
        ))}
    </div>
  )
}

interface PortFieldProps {
  value: number | null
  disabled: boolean
  onSave: (port: number | null) => void
}

function PortField({ value, disabled, onSave }: PortFieldProps) {
  const [draft, setDraft] = useState(value?.toString() ?? '')

  const save = () => {
    const normalized = draft.trim()
    if (normalized === '') {
      if (value !== null) onSave(null)
      return
    }
    const port = Number(normalized)
    if (Number.isInteger(port) && port >= 1_024 && port <= 65_535 && port !== value) {
      onSave(port)
    }
  }

  return (
    <input
      type="number"
      min={1024}
      max={65535}
      step={1}
      inputMode="numeric"
      value={draft}
      placeholder={t('settings.harnessPortAuto')}
      aria-label={t('settings.harnessPort')}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(value?.toString() ?? '')
          event.currentTarget.blur()
        }
      }}
      className="h-[30px] w-[112px] rounded-control border border-line-strong bg-surface-2 px-2.5 text-right text-[11.5px] text-text outline-none placeholder:text-faint focus:border-brand disabled:opacity-40"
    />
  )
}

/** A combination, drawn as keys rather than spelled out with plus signs. */
function Chips({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((key, index) => (
        <kbd
          // Not the key itself: a combination can repeat one, and a duplicate
          // React key is a rendering bug rather than a display one.
          key={`${index}-${key}`}
          className="grid h-[17px] min-w-[18px] place-items-center rounded-[4px] border border-line bg-canvas px-1 font-sans text-[10.5px] text-text"
        >
          {key}
        </kbd>
      ))}
    </>
  )
}

interface RowProps {
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
  label: string
  hint: string
  /** Shown under the hint when there is something to say about this setting. */
  note?: ReactNode
  children: ReactNode
}

function Row({ icon: Icon, label, hint, note, children }: RowProps) {
  return (
    <div className="flex items-start gap-3.5 px-4 py-3.5">
      <Icon size={15} strokeWidth={2} className="mt-[3px] shrink-0 text-faint" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[12.5px] font-medium text-text">{label}</span>
        <p className="text-[11.5px] leading-relaxed text-faint">{hint}</p>
        {note && <div className="mt-0.5 text-[11.5px] leading-relaxed">{note}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-[3px]">{children}</div>
    </div>
  )
}

/**
 * The first run, as three steps instead of a mode.
 *
 * It takes the content area and leaves the title bar and the status bar exactly
 * where they are, which is deliberate: this is the application setting itself up,
 * not a window that appeared in front of it. The two-region shape is the console's
 * own — a chrome rail on the left, the work on the right — so the guide reads as
 * the same piece of software the user is about to be handed, rather than as an
 * installer that will vanish and be replaced by something unfamiliar. The rail is
 * the sidebar's width for the same reason: its edge lands on the title bar's
 * divider, and the window does not appear to rearrange itself when the guide ends.
 *
 * Nothing here is exclusive to it. Step one is the console's environment checks,
 * step two is the console's agent picker, and step three is the button the console
 * has always had. That is what makes it safe to skip — and why the footer offers
 * to, on the left, where a control that opts out belongs.
 */
import type { ReactNode } from 'react'
import { Check, Loader2, Terminal } from 'lucide-react'

import { Ambient } from '@/components/Ambient'
import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/Button'
import { EnvironmentChecks, EnvironmentProgress } from '@/components/Environment'
import { PresetPicker } from '@/components/PresetPicker'
import { t, type MessageKey } from '@/lib/i18n'
import { useHarness } from '@/state/harness'
import { STEPS, useOnboarding } from '@/state/onboarding'
import { usePresets } from '@/state/presets'

/** In order, and the same order the rail lists them in. */
const TITLES: MessageKey[] = ['guide.step.runtime', 'guide.step.agent', 'guide.step.session']

export function Onboarding() {
  const step = useOnboarding((state) => state.step)
  const go = useOnboarding((state) => state.go)
  const finish = useOnboarding((state) => state.finish)

  const environment = useHarness((state) => state.environment)
  const status = useHarness((state) => state.status)
  const busy = useHarness((state) => state.busy)
  const installing = useHarness((state) => state.installing)
  const provisioningNode = useHarness((state) => state.provisioningNode)
  const start = useHarness((state) => state.start)

  const ready =
    environment !== null &&
    environment.node !== null &&
    environment.harnessInstalled &&
    environment.harnessCompatible &&
    environment.workspaceAdmission.state !== 'blocked'
  const running = status.phase === 'ready'
  const starting = busy || status.phase === 'starting' || status.phase === 'restarting'
  const working = installing || provisioningNode

  const last = step === STEPS - 1
  // The one gate in the guide, and it is a fact rather than a rule: there is
  // nothing for the later steps to configure until the harness is on the machine.
  const blocked = step === 0 && !ready

  const advance = () => {
    if (!last) {
      go(step + 1)
      return
    }
    // Started and handed over in the same gesture. The guide closes without
    // waiting for the process, because the console behind it is already the right
    // place to watch a start — and the right place to read a start that failed.
    if (!running) void start()
    finish()
  }

  return (
    <div className="flex min-h-0 flex-1 animate-rise">
      <aside className="chrome relative flex w-[264px] shrink-0 flex-col border-r border-line">
        <Ambient />

        <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-6">
          <div className="flex items-center gap-3">
            <BrandMark size={40} />
            <div className="flex min-w-0 flex-col">
              <h1 className="text-ui-xl font-semibold text-text">{t('guide.welcome')}</h1>
              <p className="truncate text-ui-base text-muted">DSH Studio</p>
            </div>
          </div>

          <p className="text-ui-base text-muted">{t('guide.lead')}</p>

          <ol className="flex flex-col gap-1">
            {TITLES.map((title, index) => (
              <Rung
                key={title}
                index={index}
                label={t(title)}
                state={index < step ? 'done' : index === step ? 'current' : 'ahead'}
                // Backwards only. Forwards is the button in the footer, which is
                // the one that knows whether the step it is leaving is finished.
                onSelect={index < step ? () => go(index) : undefined}
              />
            ))}
          </ol>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
          <div className="mx-auto flex w-full max-w-[600px] flex-col gap-6">
            {step === 0 && (
              <Panel title={t('guide.runtime.title')} body={t('guide.runtime.body')}>
                <EnvironmentChecks />
                <EnvironmentProgress />
                {/* Said once the checks are readable and still short of what is
                    needed, so it explains a disabled button instead of warning
                    about one that is about to work. */}
                {environment !== null && !ready && !working && (
                  <p className="text-ui-sm text-muted">{t('guide.runtime.blocked')}</p>
                )}
                <Failure />
              </Panel>
            )}

            {step === 1 && (
              <Panel title={t('guide.agent.title')} body={t('guide.agent.body')}>
                <PresetPicker detail />
                {/* The shell does not offer a model picker, and this is the
                    sentence that says where one is instead. Providers, catalogs
                    and API keys are the harness's subsystem, with its own page
                    and its own place to keep a secret; a second copy here would
                    be a second thing to get wrong about somebody's credentials. */}
                <p className="text-ui-sm text-faint">{t('guide.agent.models')}</p>
              </Panel>
            )}

            {step === 2 && (
              <Panel title={t('guide.session.title')} body={t('guide.session.body')}>
                <Recap />
                <Failure />
              </Panel>
            )}
          </div>
        </div>

        {/* The one place on the screen with two sizes of button in a row, on
            purpose: the way on is the hero action and takes the large one, and
            the ways back and out are ordinary commands. */}
        <footer className="chrome flex shrink-0 items-center gap-2 border-t border-line px-6 py-3">
          <Button variant="ghost" onClick={finish}>
            {t('guide.skip')}
          </Button>

          <div className="ml-auto flex items-center gap-2">
            {step > 0 && (
              <Button variant="secondary" onClick={() => go(step - 1)}>
                {t('guide.back')}
              </Button>
            )}
            <Button
              variant="primary"
              size="lg"
              onClick={advance}
              disabled={blocked || working || (last && starting)}
            >
              {last ? <Begin running={running} starting={starting} /> : t('guide.next')}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  )
}

/** What the last button says, which depends on whether there is already a service. */
function Begin({ running, starting }: { running: boolean; starting: boolean }) {
  if (starting) {
    return (
      <>
        <Loader2 className="animate-spin" aria-hidden="true" />
        {t('action.starting')}
      </>
    )
  }

  return (
    <>
      <Terminal aria-hidden="true" />
      {running ? t('guide.session.open') : t('guide.session.begin')}
    </>
  )
}

/** A step's heading, its one paragraph, and whatever it is about. */
function Panel({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <>
      <header className="flex flex-col gap-2">
        <h2 className="text-ui-2xl font-semibold text-text">{title}</h2>
        <p className="text-ui-base text-muted">{body}</p>
      </header>
      <div className="flex flex-col gap-3">{children}</div>
    </>
  )
}

/**
 * One step in the rail.
 *
 * The number becomes a tick once the step is behind you, which is the whole of
 * the progress indicator: three rows, and the shape of the marker says where you
 * are without a bar that has to be interpreted. The row is the sidebar's row —
 * the current step takes the selected fill, and only the steps behind you answer
 * the pointer.
 */
function Rung({
  index,
  label,
  state,
  onSelect,
}: {
  index: number
  label: string
  state: 'done' | 'current' | 'ahead'
  onSelect?: () => void
}) {
  const marker = {
    done: 'border-transparent bg-ok/15 text-ok',
    current: 'border-transparent bg-brand text-on-brand',
    ahead: 'border-line-strong text-faint',
  }[state]

  const row = {
    done: 'text-muted hover:bg-surface-2/70 hover:text-text',
    current: 'bg-surface-2 font-medium text-text',
    ahead: 'text-faint',
  }[state]

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={onSelect === undefined}
        aria-current={state === 'current' ? 'step' : undefined}
        className={[
          'flex h-10 w-full items-center gap-3 rounded-lg px-2 text-left text-ui-base transition-colors duration-100',
          onSelect ? 'cursor-pointer' : 'cursor-default',
          row,
        ].join(' ')}
      >
        <span
          className={`grid size-6 shrink-0 place-items-center rounded-full border text-ui-xs font-semibold tabular-nums ${marker}`}
        >
          {state === 'done' ? <Check size={14} strokeWidth={2.4} aria-hidden="true" /> : index + 1}
        </span>
        <span className="min-w-0 truncate">{label}</span>
      </button>
    </li>
  )
}

/**
 * The two facts the first session is about to be made out of.
 *
 * Shown because both were decided somewhere the user cannot see: the agent is a
 * key in the harness's settings and the directory is a default this shell picked.
 * Saying them out loud once, before anything runs in them, is cheaper than
 * finding out afterwards.
 */
function Recap() {
  const workspace = useHarness((state) => state.environment?.workspace ?? null)
  const presets = usePresets((state) => state.presets)
  const chosen = usePresets((state) => state.chosen)

  const preset = presets.find((candidate) => candidate.id === chosen)
  const agent = preset ? (preset.name ?? preset.id) : chosen

  return (
    <dl className="list-card">
      {agent && <Fact label={t('section.agent')} value={agent} />}
      {workspace && <Fact label={t('guide.session.workspace')} value={workspace} mono />}
    </dl>
  )
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="list-row">
      <dt className="shrink-0 text-ui-base text-muted">{label}</dt>
      <dd
        data-hint={value}
        className={`ml-auto min-w-0 truncate text-text ${mono ? 'font-mono text-ui-sm' : 'text-ui-base'}`}
      >
        {value}
      </dd>
    </div>
  )
}

/** Whatever went wrong last, in the step that asked for it. */
function Failure() {
  const error = useHarness((state) => state.error)
  if (!error) return null

  return (
    <p className="selectable rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger">
      {error}
    </p>
  )
}

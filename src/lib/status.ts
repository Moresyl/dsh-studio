/**
 * How a supervisor phase is described and coloured.
 *
 * The status bar and the control panel both report the same thing at the same
 * moment, so they read it from here rather than each keeping an opinion — two
 * status indicators that disagree are worse than one.
 */
import { t } from '@/lib/i18n'
import type { Status } from '@/lib/ipc'

export interface Tone {
  /** CSS colour for the indicator dot. */
  color: string
  /** Whether the phase is transient, and so worth animating. */
  live: boolean
}

const TONE: Record<Status['phase'], Tone> = {
  stopped: { color: 'var(--color-faint)', live: false },
  starting: { color: 'var(--color-brand)', live: true },
  ready: { color: 'var(--color-ok)', live: false },
  restarting: { color: 'var(--color-warn)', live: true },
  failed: { color: 'var(--color-danger)', live: false },
}

export const toneOf = (status: Status): Tone => TONE[status.phase]

export const labelOf = (status: Status): string =>
  status.phase === 'restarting'
    ? t('status.restarting', { attempt: status.attempt })
    : t(`status.${status.phase}`)

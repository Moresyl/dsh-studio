import { describe } from '@/lib/errors'
import { t } from '@/lib/i18n'
import { showError } from '@/state/dialog'

/**
 * Keep a failure beside the control that caused it and also make it impossible
 * to miss. Call this only for an explicit user action; background refreshes and
 * type-ahead searches must remain quiet when the machine is offline.
 */
export function reportFailure(cause: unknown): string {
  const details = describe(cause, t('dialog.failure.unknown'))
  showError({
    title: t('dialog.failure.title'),
    body: t('dialog.failure.body'),
    details,
    close: t('dialog.error.close'),
    copy: t('dialog.error.copy'),
    copied: t('dialog.error.copied'),
  })
  return details
}

/**
 * Run one explicit user action without leaving a rejected Promise behind.
 *
 * Event handlers cannot await the Promise they start. Keeping this wrapper at
 * that boundary makes native dialog, clipboard, opener and window failures use
 * the same copyable application error as state-changing actions.
 */
export async function reportAction<T>(action: () => Promise<T>): Promise<T | null> {
  try {
    return await action()
  } catch (cause) {
    reportFailure(cause)
    return null
  }
}

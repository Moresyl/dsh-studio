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

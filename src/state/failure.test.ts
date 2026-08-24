import { beforeEach, describe, expect, it } from 'vitest'

import { useDialog } from '@/state/dialog'
import { reportFailure } from '@/state/failure'
import { t } from '@/lib/i18n'

beforeEach(() => useDialog.setState({ pending: null }))

describe('reportFailure', () => {
  it('returns the stable inline detail and opens a copyable global error', () => {
    expect(reportFailure(new Error('terminal could not start'))).toBe('terminal could not start')
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: 'terminal could not start',
    })
  })

  it('does not expose object internals when a backend rejects with an opaque value', () => {
    expect(reportFailure({ token: 'secret' })).toBe(t('dialog.failure.unknown'))
    expect(useDialog.getState().pending).toMatchObject({
      kind: 'error',
      details: t('dialog.failure.unknown'),
    })
  })
})

import { beforeEach, describe, expect, it } from 'vitest'

import { ask, showError, useDialog } from '@/state/dialog'

const notice = {
  title: 'Plugin operation failed',
  body: 'The operation did not finish.',
  details: 'ERR_PNPM_FETCH_404 missing-package',
  close: 'Close',
  copy: 'Copy error',
  copied: 'Copied',
}

beforeEach(() => useDialog.setState({ pending: null }))

describe('application dialogs', () => {
  it('shows a copyable error and closes it without a pending promise', () => {
    showError(notice)

    expect(useDialog.getState().pending).toMatchObject({ kind: 'error', ...notice })
    useDialog.getState().settle(false)
    expect(useDialog.getState().pending).toBeNull()
  })

  it('answers a displaced confirmation with no before showing an error', async () => {
    const answer = ask({
      title: 'Remove?',
      body: 'This changes the profile.',
      confirm: 'Remove',
      tone: 'danger',
    })

    showError(notice)

    await expect(answer).resolves.toBe(false)
    expect(useDialog.getState().pending?.kind).toBe('error')
  })
})

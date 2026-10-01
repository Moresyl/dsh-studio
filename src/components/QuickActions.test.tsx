import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// The view table reads the platform at import, and there is no window here.
vi.mock('@/lib/platform', () => ({ ACCELERATOR: 'Ctrl+', isMac: false, standby: false }))

import { t } from '@/lib/i18n'

import { QuickActionsView } from './QuickActions'

const NOOP = {
  onHarness: vi.fn(),
  onView: vi.fn(),
  onProfiles: vi.fn(),
  onWorkspace: vi.fn(),
}

const READY = { phase: 'ready', origin: 'http://127.0.0.1:52418', pid: 1 } as const
const WORKSPACE = 'C:\\work\\atlas'

// Expected text comes from the same table the page reads, so the checks hold in
// whichever language the test machine happens to be set to.
describe('QuickActionsView', () => {
  it('is a page of its own, with one button for each place it leads', () => {
    const markup = renderToStaticMarkup(
      <QuickActionsView status={READY} profile="web" workspace={WORKSPACE} {...NOOP} />,
    )

    // Harness, three panes of the panel, and the two dialogs that belong to the window.
    expect(markup.match(/<button/g)).toHaveLength(6)
    for (const key of [
      'quick.harness',
      'nav.terminal',
      'nav.sessions',
      'nav.plugins',
      'quick.profile',
      'quick.workspace',
    ] as const) {
      expect(markup).toContain(t(key))
    }
  })

  it('does not put the Harness window or a strip of buttons on the page', () => {
    const markup = renderToStaticMarkup(
      <QuickActionsView status={READY} profile="web" workspace={WORKSPACE} {...NOOP} />,
    )

    expect(markup).not.toContain('<iframe')
    expect(markup).not.toContain('<nav')
  })

  it('says which profile and which workspace the two dialogs are about', () => {
    const markup = renderToStaticMarkup(
      <QuickActionsView status={READY} profile="web" workspace={WORKSPACE} {...NOOP} />,
    )

    expect(markup).toContain(t('quick.profile.current', { name: 'web' }))
    expect(markup).toContain(WORKSPACE)
  })

  it('describes the two cards plainly until there is something to say about them', () => {
    const markup = renderToStaticMarkup(
      <QuickActionsView status={READY} profile={null} workspace={null} {...NOOP} />,
    )

    expect(markup).toContain(t('quick.profile.body'))
    expect(markup).toContain(t('quick.workspace.body'))
  })

  it('reports whether Harness is running', () => {
    const markup = renderToStaticMarkup(
      <QuickActionsView status={{ phase: 'stopped' }} profile={null} workspace={null} {...NOOP} />,
    )

    expect(markup).toContain(t('status.stopped'))
  })
})

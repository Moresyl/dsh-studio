import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PaneHeader } from './PaneHeader'

describe('PaneHeader', () => {
  it('renders a wide page introduction with its action', () => {
    const markup = renderToStaticMarkup(
      <PaneHeader title="Plugins" subtitle="Manage extensions">
        <button type="button">Import</button>
      </PaneHeader>,
    )

    expect(markup).toContain('pane-header')
    expect(markup).toContain('max-w-[1040px]')
    expect(markup).toContain('text-[20px]')
    expect(markup).toContain('Manage extensions')
    expect(markup).toContain('Import')
  })

  it('uses the reading measure for narrow panes', () => {
    const markup = renderToStaticMarkup(
      <PaneHeader title="Settings" subtitle="Application preferences" width="narrow" />,
    )

    expect(markup).toContain('max-w-[780px]')
    expect(markup).not.toContain('max-w-[1040px]')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { TabButton } from './TabButton'

describe('TabButton', () => {
  it('uses the inverse selected treatment and disables redundant activation', () => {
    const markup = renderToStaticMarkup(<TabButton label="Discover" active onClick={vi.fn()} />)

    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('bg-text')
    expect(markup).toContain('text-canvas')
  })

  it('keeps inactive tabs visibly interactive', () => {
    const markup = renderToStaticMarkup(
      <TabButton label="Installed" active={false} onClick={vi.fn()} />,
    )

    expect(markup).toContain('aria-pressed="false"')
    expect(markup).toContain('hover:bg-surface-2/60')
  })
})

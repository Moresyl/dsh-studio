import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Badge } from './Badge'

describe('Badge', () => {
  it('is a neutral rectangle by default', () => {
    const markup = renderToStaticMarkup(<Badge>Community</Badge>)

    expect(markup).toBe('<span class="badge">Community</span>')
  })

  it('carries its meaning in the tone', () => {
    expect(renderToStaticMarkup(<Badge tone="ok">Active</Badge>)).toContain('badge badge--ok')
    expect(renderToStaticMarkup(<Badge tone="danger">Failed</Badge>)).toContain('badge--danger')
  })

  it('passes attributes through, so it can carry a tooltip', () => {
    const markup = renderToStaticMarkup(<Badge data-hint="Window 2">2</Badge>)

    expect(markup).toContain('data-hint="Window 2"')
  })
})

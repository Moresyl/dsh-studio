import { X } from 'lucide-react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { IconButton } from './IconButton'

describe('IconButton', () => {
  it('names itself for assistive technology and for the tooltip', () => {
    const markup = renderToStaticMarkup(<IconButton label="Close" icon={X} />)

    expect(markup).toContain('aria-label="Close"')
    expect(markup).toContain('data-hint="Close"')
    expect(markup).toContain('aria-hidden="true"')
  })

  it('is a quiet 28px square by default', () => {
    const markup = renderToStaticMarkup(<IconButton label="Close" icon={X} />)

    expect(markup).toContain('btn btn--sm btn--ghost btn--icon')
  })

  it('takes size and variant like a text button', () => {
    const markup = renderToStaticMarkup(
      <IconButton label="Remove" icon={X} size="md" variant="danger-ghost" disabled />,
    )

    expect(markup).toContain('btn--md')
    expect(markup).toContain('btn--danger-ghost')
    expect(markup).toContain('disabled=""')
  })
})

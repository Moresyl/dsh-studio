import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Button, buttonClass } from './Button'

describe('Button', () => {
  it('is the 32px primary control unless told otherwise', () => {
    const markup = renderToStaticMarkup(<Button>Continue</Button>)

    expect(markup).toContain('type="button"')
    expect(markup).toContain('class="btn btn--md btn--primary"')
  })

  it('takes its geometry from the size and its colour from the variant', () => {
    const markup = renderToStaticMarkup(
      <Button size="sm" variant="secondary">
        Continue
      </Button>,
    )

    expect(markup).toContain('btn--sm')
    expect(markup).toContain('btn--secondary')
    expect(markup).not.toContain('btn--md')
  })

  it('keeps disabled controls semantic', () => {
    const markup = renderToStaticMarkup(<Button disabled>Continue</Button>)

    expect(markup).toContain('disabled=""')
  })

  it('composes the same classes for things that must look like a button but are not one', () => {
    expect(buttonClass({ variant: 'ghost', size: 'xs', icon: true, className: 'ml-auto' })).toBe(
      'btn btn--xs btn--ghost btn--icon ml-auto',
    )
    expect(buttonClass({})).toBe('btn btn--md btn--primary')
  })
})

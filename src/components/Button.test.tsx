import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Button } from './Button'

describe('Button', () => {
  it('uses the compact ChatGPT desktop control geometry by default', () => {
    const markup = renderToStaticMarkup(<Button>Continue</Button>)

    expect(markup).toContain('h-5')
    expect(markup).toContain('rounded-[6px]')
    expect(markup).toContain('text-[12px]')
    expect(markup).toContain('font-normal')
  })

  it('keeps disabled controls semantic and visibly unavailable', () => {
    const markup = renderToStaticMarkup(<Button disabled>Continue</Button>)

    expect(markup).toContain('disabled=""')
    expect(markup).toContain('disabled:opacity-40')
  })
})

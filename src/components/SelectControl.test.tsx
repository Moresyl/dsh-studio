import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SelectControl } from './SelectControl'

describe('SelectControl', () => {
  it('keeps native select semantics while drawing a consistent chevron', () => {
    const markup = renderToStaticMarkup(
      <SelectControl aria-label="Runtime" defaultValue="stable">
        <option value="stable">Stable</option>
      </SelectControl>,
    )

    expect(markup).toContain('<select')
    expect(markup).toContain('aria-label="Runtime"')
    expect(markup).toContain('select-control__input')
    expect(markup).toContain('select-control__chevron')
    expect(markup).toContain('aria-hidden="true"')
  })

  it('forwards disabled state and density to the native control', () => {
    const markup = renderToStaticMarkup(
      <SelectControl aria-label="Channel" disabled density="small">
        <option>Default</option>
      </SelectControl>,
    )

    expect(markup).toContain('disabled=""')
    expect(markup).toContain('field-control--small')
  })
})

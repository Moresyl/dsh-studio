import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SelectControl } from './SelectControl'

describe('SelectControl', () => {
  it('renders the current option as a menu-backed selector', () => {
    const markup = renderToStaticMarkup(
      <SelectControl aria-label="Runtime" defaultValue="stable">
        <option value="stable">Stable</option>
      </SelectControl>,
    )

    expect(markup).toContain('<button')
    expect(markup).toContain('aria-label="Runtime"')
    expect(markup).toContain('aria-haspopup="menu"')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('select-control__trigger')
    expect(markup).toContain('select-control__chevron')
    expect(markup).toContain('Stable')
    expect(markup).toContain('aria-hidden="true"')
  })

  it('forwards disabled state and density to the trigger', () => {
    const markup = renderToStaticMarkup(
      <SelectControl aria-label="Channel" disabled density="small">
        <option>Default</option>
      </SelectControl>,
    )

    expect(markup).toContain('disabled=""')
    expect(markup).toContain('field-control--small')
  })
})

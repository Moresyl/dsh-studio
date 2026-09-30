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

  it('forwards disabled state and size to the trigger', () => {
    const markup = renderToStaticMarkup(
      <SelectControl aria-label="Channel" disabled size="sm">
        <option>Default</option>
      </SelectControl>,
    )

    expect(markup).toContain('disabled=""')
    expect(markup).toContain('field-control--sm')
  })

  it('joins version text and conditional badges without array separators', () => {
    const markup = renderToStaticMarkup(
      <SelectControl aria-label="Version" value="0.1.7-rc.2">
        <option value="0.1.7-rc.2">
          {'0.1.7-rc.2'}
          {false}
          {null}
          {' · Studio'}
          {' · In use'}
        </option>
      </SelectControl>,
    )

    expect(markup).toContain('0.1.7-rc.2 · Studio · In use')
    expect(markup).not.toContain('0.1.7-rc.2,')
  })

  it('preserves an explicit option label and numeric text', () => {
    const markup = renderToStaticMarkup(
      <SelectControl aria-label="Count" value="0">
        <option>{0}</option>
        <option value="1" label="One">
          Ignored text
        </option>
      </SelectControl>,
    )
    expect(markup).toContain('text-left">0</span>')
    const labelled = renderToStaticMarkup(
      <SelectControl aria-label="Count" value="1">
        <option value="1" label="One">
          Ignored text
        </option>
      </SelectControl>,
    )
    expect(labelled).toContain('text-left">One</span>')
    expect(labelled).not.toContain('Ignored text')
  })
})

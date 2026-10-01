import { Monitor, Moon } from 'lucide-react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { Segmented } from './Segmented'

const ITEMS = [
  { value: 'discover', label: 'Discover' },
  { value: 'installed', label: 'Installed' },
] as const

describe('Segmented', () => {
  it('is one named group with the current segment pressed', () => {
    const markup = renderToStaticMarkup(
      <Segmented label="Plugins" items={ITEMS} value="discover" onChange={vi.fn()} />,
    )

    expect(markup).toContain('role="group"')
    expect(markup).toContain('aria-label="Plugins"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).toContain('class="segmented"')
    expect(markup).toContain('Installed')
  })

  it('steps down to the 28px track for toolbars', () => {
    const markup = renderToStaticMarkup(
      <Segmented label="Plugins" size="sm" items={ITEMS} value="installed" onChange={vi.fn()} />,
    )

    expect(markup).toContain('segmented segmented--sm')
  })

  it('draws only icons when asked and keeps the names for the reader', () => {
    const markup = renderToStaticMarkup(
      <Segmented
        label="Theme"
        iconOnly
        items={[
          { value: 'system', label: 'System', icon: Monitor },
          { value: 'dark', label: 'Dark', icon: Moon },
        ]}
        value="dark"
        onChange={vi.fn()}
      />,
    )

    expect(markup).toContain('segmented--icons')
    expect(markup).toContain('aria-label="System"')
    expect(markup).toContain('data-hint="Dark"')
    expect(markup).not.toContain('segmented__label')
  })

  it('collapses to icons on a narrow window without losing the label', () => {
    const markup = renderToStaticMarkup(
      <Segmented
        label="View"
        responsive
        items={[{ value: 'panel', label: 'Control panel', icon: Monitor }]}
        value="panel"
        onChange={vi.fn()}
      />,
    )

    expect(markup).toContain('segmented--responsive')
    expect(markup).toContain('segmented__label')
    expect(markup).toContain('aria-label="Control panel"')
  })

  it('says what a segment is when it has more to say than its label', () => {
    const markup = renderToStaticMarkup(
      <Segmented
        label="View"
        responsive
        items={[
          { value: 'extended', label: 'Quick actions', hint: 'A quick page of its own' },
          { value: 'panel', label: 'Control panel' },
        ]}
        value="panel"
        onChange={vi.fn()}
      />,
    )

    expect(markup).toContain('data-hint="A quick page of its own"')
    // The label still names it for a reader; the hint is only what a pointer gets.
    expect(markup).toContain('aria-label="Quick actions"')
    // With nothing more to say, the label is the hint.
    expect(markup).toContain('data-hint="Control panel"')
  })
})

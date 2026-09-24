import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { Switch } from '@/components/Switch'

describe('Switch', () => {
  it('exposes the checked state and exact desktop track geometry', () => {
    const markup = renderToStaticMarkup(
      <Switch on label="Automatic updates" onChange={vi.fn()} />,
    )

    expect(markup).toContain('role="switch"')
    expect(markup).toContain('aria-checked="true"')
    expect(markup).toContain('h-[19px] w-[32px]')
    expect(markup).toContain('size-[13px]')
    expect(markup).toContain('bg-switch-on')
  })

  it('uses the dedicated disabled track state while preserving semantics', () => {
    const markup = renderToStaticMarkup(
      <Switch on={false} disabled label="Telemetry" onChange={vi.fn()} />,
    )

    expect(markup).toContain('aria-checked="false"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('disabled:bg-switch-off-disabled')
  })

  it('replaces the thumb with a named busy indicator', () => {
    const markup = renderToStaticMarkup(
      <Switch on busy label="Restarting harness" onChange={vi.fn()} />,
    )

    expect(markup).toContain('disabled=""')
    expect(markup).toContain('animate-spin')
    expect(markup).not.toContain('size-[13px]')
  })
})

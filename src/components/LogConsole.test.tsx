import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LogConsole } from './LogConsole'

describe('diagnostic log disclosure', () => {
  it('keeps normal startup details collapsed', () => {
    const markup = renderToStaticMarkup(
      <LogConsole
        lines={[{ stream: 'stdout', line: 'GUI shell environment: process (windows)' }]}
        onClear={() => {}}
      />,
    )
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('GUI shell environment')
  })

  it('opens unknown stderr errors instead of hiding evidence', () => {
    const markup = renderToStaticMarkup(
      <LogConsole
        lines={[{ stream: 'stderr', line: 'Error: broken profile overlay' }]}
        onClear={() => {}}
      />,
    )
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('Error: broken profile overlay')
  })

  it('shows a skipped plugin summary even with raw output collapsed', () => {
    const markup = renderToStaticMarkup(
      <LogConsole
        lines={[
          {
            stream: 'stderr',
            line: 'dsh: skipping profile bundle "dsh-diagram": Error: Plugin is incompatible with dsh 0.1.7-rc.2',
          },
        ]}
        onClear={() => {}}
      />,
    )
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('dsh-diagram')
    expect(markup).not.toContain('Error: Plugin')
  })
})

import { describe, expect, it } from 'vitest'

import { pluginDisplayName, pluginVersionAction } from './plugin-presentation'
import type { InstalledPlugin } from './ipc'

describe('readable plugin names', () => {
  it.each([
    ['dsh-diagram', 'Diagram'],
    ['@deepseek-ai/dsh-web-app', 'Web app'],
    ['@vendor/my_tool', 'My tool'],
    ['DSH-Tool', 'DSH Tool'],
    ['dsh-', 'dsh-'],
    ['', ''],
  ])('renders %s without inventing metadata', (name, expected) => {
    expect(pluginDisplayName(name)).toBe(expected)
  })
})

describe('plugin version actions', () => {
  const installed: InstalledPlugin = {
    name: 'dsh-diagram',
    spec: '^0.2.0',
    installedVersion: '0.2.0',
    active: true,
    disabled: false,
    builtin: false,
    marketReceipt: null,
  }
  it('uses the actual installed version, not its range', () => {
    expect(pluginVersionAction(installed, { version: '0.2.0' }, 'npm')).toBe('current')
    expect(pluginVersionAction(installed, { version: '0.6.0' }, 'npm')).toBe('replace')
    expect(
      pluginVersionAction(
        { ...installed, installedVersion: null, spec: '0.2.0' },
        { version: '0.2.0' },
        'npm',
      ),
    ).toBe('current')
  })
  it('never turns builtin or local package management into a registry replacement', () => {
    expect(pluginVersionAction({ ...installed, builtin: true }, { version: '0.6.0' }, 'npm')).toBe(
      'manage',
    )
    expect(pluginVersionAction(installed, { version: '0.6.0' }, 'profile')).toBe('manage')
    expect(pluginVersionAction(installed, null, 'npm')).toBe('manage')
    expect(pluginVersionAction(null, { version: '0.6.0' }, 'npm')).toBe('install')
  })
})

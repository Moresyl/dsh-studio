import { describe, expect, it } from 'vitest'

import { pluginDisplayName } from './plugin-presentation'

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

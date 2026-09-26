import { describe, expect, it } from 'vitest'

import { runtimeNotices } from './runtime-notices'

describe('runtime notices', () => {
  const skipped = {
    stream: 'stderr' as const,
    line: 'dsh: skipping profile bundle "dsh-diagram": Error: Plugin dsh-diagram@0.2.0 is incompatible with dsh 0.1.7-rc.2: peerDependencies {}',
  }

  it('identifies incompatible and other skipped bundles without claiming startup failed', () => {
    expect(
      runtimeNotices([
        skipped,
        skipped,
        { stream: 'stderr', line: 'dsh: skipping profile bundle "@vendor/tool": broken patch' },
      ]),
    ).toEqual([
      { name: 'dsh-diagram', incompatible: true },
      { name: '@vendor/tool', incompatible: false },
    ])
  })

  it('forgets previous attempts at the launch boundary', () => {
    expect(
      runtimeNotices([
        skipped,
        { stream: 'stdout', line: 'GUI shell environment: process (windows)' },
        { stream: 'stdout', line: 'dsh web: http://127.0.0.1:1234/' },
      ]),
    ).toEqual([])
  })

  it('keeps ordinary messages and incomplete JSON out of actionable notices', () => {
    expect(
      runtimeNotices([
        { stream: 'stderr', line: '[dsh-deeptutor] plugin loaded (html script: file)' },
        { stream: 'stderr', line: 'dsh: skipping profile bundle "bad\\q": Error' },
        { stream: 'stderr', line: 'Error: failed to parse profile' },
      ]),
    ).toEqual([])
  })
})

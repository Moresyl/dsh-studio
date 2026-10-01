import { expect, it } from 'vitest'
import type { SessionCard } from '@/lib/ipc'
import { workspaceKey, workspaceSummaries } from '@/lib/workspace-summary'
it('normalizes Windows aliases while preserving Unix case and root', () => {
  expect(workspaceKey('D:\\Work\\')).toBe(workspaceKey('d:/work'))
  expect(workspaceKey('\\\\Server\\Work')).toBe('//server/work')
  expect(workspaceKey('/')).toBe('/')
  expect(workspaceKey('/Work')).not.toBe(workspaceKey('/work'))
})
it('groups usage, ranks the current folder first and retains empty workspaces', () => {
  const cards = (['D:\\Work', 'd:/work/', '/other', ''] as const).map(
    (project, index) =>
      ({ project, turns: 2, touched: index, tokens: { input: 3, output: 4 } }) as SessionCard,
  )
  const result = workspaceSummaries(cards, 'D:/WORK')
  expect(result).toEqual([
    { path: 'D:/WORK', current: true, sessions: 2, turns: 4, tokens: 14, touched: 1 },
    { path: '/other', current: false, sessions: 1, turns: 2, tokens: 7, touched: 2 },
  ])
  expect(workspaceSummaries([], '/new')[0]?.sessions).toBe(0)
  expect(workspaceSummaries([], null)).toEqual([])
  expect(workspaceSummaries(cards, null)[0]?.path).toBe('/other')
})

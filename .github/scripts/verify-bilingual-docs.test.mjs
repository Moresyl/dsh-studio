import assert from 'node:assert/strict'
import test from 'node:test'

import { validateBilingualPair, verifyBilingualDocs } from './verify-bilingual-docs.mjs'

test('bilingual pair validation reports every missing shared fact', () => {
  const problems = validateBilingualPair(
    'docs/user-guide.md',
    'ordinary content '.repeat(20),
    'docs/user-guide.zh-CN.md',
    '普通内容'.repeat(60),
  )
  assert.equal(problems.length, 8)
  assert(problems.some((problem) => problem.includes('Quick actions')))
  assert(problems.some((problem) => problem.includes('快捷操作模式')))
})

test('repository bilingual capability documents stay synchronized', async () => {
  assert.deepEqual(await verifyBilingualDocs(), { pairs: 9 })
})

test('shared facts spanning lines accept Windows checkouts', () => {
  const english = `${'ordinary content '.repeat(10)}\r\n## Implemented\r\n## In development\r\n## Release gates\r\nHost Protocol 1`
  const chinese = `${'普通内容'.repeat(40)}\r\n## 已交付\r\n## 开发中\r\n## 发布门禁\r\nHost Protocol 1`
  assert.deepEqual(
    validateBilingualPair('docs/ROADMAP.md', english, 'docs/ROADMAP.zh-CN.md', chinese),
    [],
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BENCHMARK_HEAD,
  validateBilingualPair,
  verifyBilingualDocs,
} from './verify-bilingual-docs.mjs'

test('bilingual pair validation reports every missing shared fact', () => {
  const problems = validateBilingualPair(
    'docs/user-guide.md',
    'ordinary content '.repeat(20),
    'docs/user-guide.zh-CN.md',
    '普通内容'.repeat(60),
  )
  assert.equal(problems.length, 8)
  assert(problems.some((problem) => problem.includes('Extended')))
  assert(problems.some((problem) => problem.includes('扩展模式')))
})

test('repository bilingual capability documents stay synchronized', async () => {
  assert.deepEqual(await verifyBilingualDocs(), { pairs: 8 })
})

test('shared facts spanning lines accept Windows checkouts', () => {
  const english = `${'ordinary content '.repeat(10)}dataelement/dsh-desktop\r\n${BENCHMARK_HEAD} v0.9.0 formal release`
  const chinese = `${'普通内容'.repeat(40)}dataelement/dsh-desktop ${BENCHMARK_HEAD} v0.9.0 正式版本`
  assert.deepEqual(
    validateBilingualPair('docs/ROADMAP.md', english, 'docs/ROADMAP.zh-CN.md', chinese),
    [],
  )
})

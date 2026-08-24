import assert from 'node:assert/strict'
import test from 'node:test'

import { validateBundleInventory, verifyBundleBudget } from './verify-bundle-budget.mjs'

test('entry and terminal chunks stay separate and bounded', () => {
  assert.deepEqual(
    validateBundleInventory(
      [
        { name: 'index-hash.js', size: 300_000 },
        { name: 'terminals-hash.js', size: 350_000 },
      ],
      'index-hash.js',
    ),
    [],
  )
})

test('missing, merged, duplicate, and oversized terminal payloads fail closed', () => {
  assert(validateBundleInventory([{ name: 'index.js', size: 1_000_000 }], 'index.js').length >= 2)
  assert(
    validateBundleInventory(
      [
        { name: 'terminals-a.js', size: 100 },
        { name: 'terminals-b.js', size: 100 },
      ],
      'terminals-a.js',
    ).some((problem) => problem.includes('exactly one')),
  )
})

test('production bundle meets its payload contract', async () => {
  const result = await verifyBundleBudget()
  assert(result.entryBytes > 0)
  assert(result.terminalBytes > 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { selectPreviousRelease } from './release-history.mjs'

test('selects the greatest lower semantic version regardless of creation order', () => {
  assert.equal(
    selectPreviousRelease(
      ['v0.9.7', 'v0.9.10', 'v0.9.9', 'v0.9.11', 'v0.9.10', 'notes', 'v0.9.12-rc.1'],
      'v0.9.11',
    ),
    'v0.9.10',
  )
})

test('rejects publishing an older version over a newer stable release', () => {
  assert.throws(
    () => selectPreviousRelease(['v0.10.0', 'v0.9.19'], 'v0.9.20'),
    /older than published stable release v0\.10\.0/,
  )
})

test('excludes the current release and accepts the first stable version', () => {
  assert.equal(selectPreviousRelease(['v1.0.0'], 'v1.0.0'), '')
  assert.equal(selectPreviousRelease([], 'v1.0.0'), '')
})

test('rejects malformed or non-stable current release tags', () => {
  for (const tag of ['1.0.0', 'v01.0.0', 'v1.0.0-rc.1', undefined]) {
    assert.throws(() => selectPreviousRelease(['v0.9.0'], tag), /canonical stable version/)
  }
})

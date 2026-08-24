import assert from 'node:assert/strict'
import test from 'node:test'

import { validateAccessibilitySource, verifyAccessibility } from './verify-accessibility.mjs'

test('icon-only buttons need an explicit accessible name', () => {
  assert.deepEqual(validateAccessibilitySource('fixture.tsx', '<button><X /></button>'), [
    'fixture.tsx:1 button has no accessible name',
  ])
  assert.deepEqual(
    validateAccessibilitySource(
      'fixture.tsx',
      '<button aria-label="Close"><X aria-hidden="true" /></button>',
    ),
    [],
  )
})

test('custom role buttons remain keyboard reachable', () => {
  const problems = validateAccessibilitySource(
    'fixture.tsx',
    '<div role="button"><span>{title}</span></div>',
  )
  assert(problems.some((problem) => problem.includes('tabIndex')))
  assert(problems.some((problem) => problem.includes('keyboard handler')))
})

test('modal dialogs expose modal state and an accessible name', () => {
  assert.equal(
    validateAccessibilitySource('fixture.tsx', '<div role="dialog"><h2>Title</h2></div>').length,
    2,
  )
  assert.deepEqual(
    validateAccessibilitySource(
      'fixture.tsx',
      '<div role="dialog" aria-modal="true" aria-labelledby="title"><h2 id="title">Title</h2></div>',
    ),
    [],
  )
})

test('form controls need ARIA, an associated label, or a wrapping label', () => {
  assert.deepEqual(validateAccessibilitySource('fixture.tsx', '<input placeholder="Search" />'), [
    'fixture.tsx:1 input has no associated label',
  ])
  assert.deepEqual(
    validateAccessibilitySource(
      'fixture.tsx',
      '<><label htmlFor="query">Search</label><input id="query" /></>',
    ),
    [],
  )
  assert.deepEqual(
    validateAccessibilitySource('fixture.tsx', '<label>Search<input /></label>'),
    [],
  )
})

test('repository accessibility contracts stay enforced', async () => {
  const result = await verifyAccessibility()
  assert(result.files > 20)
})

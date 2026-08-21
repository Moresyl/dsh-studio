import assert from 'node:assert/strict'
import test from 'node:test'

import { pinContract } from './pin-runtime-contract.mjs'

test('runtime contracts pin root versions and canonicalize tarball URLs', () => {
  const { package: manifest, lock } = pinContract({
    name: 'harness',
    packages: {
      '': { dependencies: { example: '^1.0.0' } },
      'node_modules/example': {
        version: '1.2.3',
        resolved: 'https://registry.npmmirror.com/example/-/example-1.2.3.tgz',
        integrity: 'sha512-example',
      },
    },
  })

  assert.deepEqual(manifest.dependencies, { example: '1.2.3' })
  assert.equal(lock.packages[''].dependencies.example, '1.2.3')
  assert.equal(
    lock.packages['node_modules/example'].resolved,
    'https://registry.npmjs.org/example/-/example-1.2.3.tgz',
  )
})

test('runtime contracts fail when a root dependency is not locked', () => {
  assert.throws(
    () => pinContract({ packages: { '': { dependencies: { missing: '1.0.0' } } } }),
    /no installed missing/,
  )
})

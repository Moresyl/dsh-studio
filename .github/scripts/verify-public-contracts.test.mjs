import assert from 'node:assert/strict'
import test from 'node:test'

import {
  protocolNumber,
  validateCapabilities,
  validateCatalogSchema,
  validateVersions,
  verifyPublicContracts,
} from './verify-public-contracts.mjs'

test('desktop plugin capabilities stay on the reviewed least-privilege surface', () => {
  const permissions = [
    'dialog:allow-open',
    'dialog:allow-save',
    'clipboard-manager:allow-read-text',
    'opener:allow-reveal-item-in-dir',
    { identifier: 'opener:allow-open-url', allow: [{ url: 'https://*' }] },
    'process:allow-restart',
    'updater:allow-check',
    'updater:allow-download-and-install',
  ]
  assert.doesNotThrow(() => validateCapabilities({ permissions }))
  assert.throws(
    () => validateCapabilities({ permissions: [...permissions, 'process:default'] }),
    /broad process:default/,
  )
  assert.throws(
    () =>
      validateCapabilities({
        permissions: permissions.filter((item) => item !== 'dialog:allow-save'),
      }),
    /dialog:allow-save/,
  )
})

test('protocol declarations require one positive integer', () => {
  assert.equal(protocolNumber('PROTOCOL = 3', /PROTOCOL = (\d+)/g, 'fixture'), 3)
  assert.throws(() => protocolNumber('nothing', /PROTOCOL = (\d+)/g, 'fixture'), /exactly one/)
  assert.throws(
    () => protocolNumber('PROTOCOL = 2; PROTOCOL = 3', /PROTOCOL = (\d+)/g, 'fixture'),
    /exactly one/,
  )
})

test('catalog schema validates its native security limits', () => {
  const schema = {
    properties: { schemaVersion: { const: '1.0.0' }, items: { maxItems: 10_000 } },
    $defs: { item: { required: ['package', 'latestVersion'] } },
  }
  assert.doesNotThrow(() => validateCatalogSchema(schema))
  assert.throws(() => validateCatalogSchema({}), /schemaVersion/)
  assert.throws(
    () => validateCatalogSchema({ ...schema, properties: { ...schema.properties, items: {} } }),
    /10,000/,
  )
})

test('release and SDK versions stay aligned', () => {
  assert.doesNotThrow(() =>
    validateVersions({ version: '0.7.1' }, { version: '0.7.1' }, { version: '0.7.1' }),
  )
  assert.throws(
    () => validateVersions({ version: '0.7.0' }, { version: '0.7.1' }, { version: '0.7.0' }),
    /differ/,
  )
  assert.throws(
    () => validateVersions({ version: 'next' }, { version: 'next' }, { version: 'next' }),
    /semantic/,
  )
})

test('repository public contracts agree end to end', async () => {
  const result = await verifyPublicContracts()
  assert.deepEqual(result, {
    protocol: 3,
    hostProtocol: 1,
    schema: '1.0.0',
    version: '0.9.2',
  })
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  protocolNumber,
  validateCapabilities,
  validateCatalogSchema,
  validateCommandAcl,
  validateVersions,
  verifyPublicContracts,
} from './verify-public-contracts.mjs'

test('desktop plugin capabilities stay on the reviewed least-privilege surface', () => {
  const permissions = [
    'core:window:allow-close',
    'core:window:allow-destroy',
    'core:window:allow-hide',
    'dialog:allow-open',
    'dialog:allow-save',
    'clipboard-manager:allow-read-text',
    'opener:allow-reveal-item-in-dir',
    { identifier: 'opener:allow-open-url', allow: [{ url: 'https://*' }] },
    'shell-commands',
  ]
  assert.doesNotThrow(() => validateCapabilities({ permissions }))
  for (const permission of [
    'core:window:allow-close',
    'core:window:allow-destroy',
    'core:window:allow-hide',
  ]) {
    assert.throws(
      () =>
        validateCapabilities({ permissions: permissions.filter((item) => item !== permission) }),
      new RegExp(permission),
    )
  }
  assert.throws(
    () => validateCapabilities({ permissions: [...permissions, 'process:default'] }),
    /broad process:default/,
  )
  assert.throws(
    () => validateCapabilities({ permissions: [...permissions, 'process:allow-restart'] }),
    /broad process:allow-restart/,
  )
  for (const permission of ['updater:allow-download-and-install', 'updater:allow-install']) {
    assert.throws(
      () => validateCapabilities({ permissions: [...permissions, permission] }),
      /broad updater:/,
    )
  }
  assert.throws(
    () =>
      validateCapabilities({
        permissions: permissions.filter((item) => item !== 'dialog:allow-save'),
      }),
    /dialog:allow-save/,
  )
})

test('every renderer command is both registered and allowed by the shell ACL', () => {
  const ipc = `invoke('desktop_offer'); invoke<Result>('desktop_file_offer')`
  const rust = `tauri::generate_handler![
    desktop::desktop_offer,
    desktop::desktop_file_offer,
  ])`
  const permissions = `commands.allow = [
    "desktop_offer",
    "desktop_file_offer",
  ]`

  assert.deepEqual(validateCommandAcl(ipc, rust, permissions), {
    invoked: 2,
    registered: 2,
    allowed: 2,
  })
  assert.throws(
    () =>
      validateCommandAcl(
        ipc,
        rust,
        `commands.allow = [
      "desktop_offer",
    ]`,
      ),
    /desktop_file_offer is not allowed/,
  )
  assert.throws(
    () =>
      validateCommandAcl(
        ipc,
        `tauri::generate_handler![
          desktop::desktop_offer,
        ])`,
        permissions,
      ),
    /desktop_file_offer is not registered/,
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
  const cargoManifest = (version = '0.7.1') => `
[workspace.package]
version = "${version}"

[workspace.dependencies]
example = { version = "99.0.0" }

[package]
name = "dsh-studio"
version.workspace = true

[dependencies]
example = "88.0.0"
`
  const cargoLock = (version = '0.7.1') => `
[[package]]
name = "dependency"
version = "77.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "dsh-studio"
version = "${version}"
`
  assert.doesNotThrow(() =>
    validateVersions(
      { version: '0.7.1' },
      { version: '0.7.1' },
      { version: '0.7.1' },
      cargoManifest(),
      cargoLock(),
    ),
  )
  assert.throws(
    () =>
      validateVersions(
        { version: '0.7.0' },
        { version: '0.7.1' },
        { version: '0.7.0' },
        cargoManifest('0.7.0'),
        cargoLock('0.7.0'),
      ),
    /differ/,
  )
  assert.throws(
    () =>
      validateVersions(
        { version: '0.7.1-beta.1' },
        { version: '0.7.1-beta.1' },
        { version: '0.7.1-beta.1' },
        cargoManifest('0.7.1-beta.1'),
        cargoLock('0.7.1-beta.1'),
      ),
    /stable semantic version/,
  )
  assert.throws(
    () =>
      validateVersions(
        { version: '0.7.1' },
        { version: '0.7.1' },
        { version: '0.7.1' },
        cargoManifest('0.7.2'),
        cargoLock(),
      ),
    /Cargo\.toml=0\.7\.2/,
  )
  assert.throws(
    () =>
      validateVersions(
        { version: '0.7.1' },
        { version: '0.7.1' },
        { version: '0.7.1' },
        cargoManifest(),
        cargoLock('0.7.2'),
      ),
    /Cargo\.lock=0\.7\.2/,
  )
})

test('native version extraction ignores dependencies and fails on ambiguous project metadata', () => {
  const manifest = `
[workspace.package]
version = "0.7.1"

[workspace.dependencies]
dependency = { version = "9.9.9" }

[package]
name = "dsh-studio"
version.workspace = true
`
  const lock = `
[[package]]
name = "dsh-studio"
version = "9.9.9"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "dsh-studio"
version = "0.7.1"
`
  const validate = (cargoManifest = manifest, cargoLock = lock) =>
    validateVersions(
      { version: '0.7.1' },
      { version: '0.7.1' },
      { version: '0.7.1' },
      cargoManifest,
      cargoLock,
    )

  assert.doesNotThrow(validate)
  assert.throws(
    () => validate(manifest.replace('version.workspace = true', 'edition.workspace = true')),
    /must declare exactly one version/,
  )
  assert.throws(
    () => validate(manifest, `${lock}\n[[package]]\nname = "dsh-studio"\nversion = "0.7.1"\n`),
    /exactly one local dsh-studio package/,
  )
  assert.throws(
    () => validate(manifest.replace('name = "dsh-studio"', 'name = "renamed"')),
    /package name must be dsh-studio/,
  )
})

test('main CI verifies Tauri guest/native versions immediately after dependency install', async () => {
  const source = await readFile('.github/workflows/ci.yml', 'utf8')
  assert.match(source, /push:\s*\r?\n\s*branches: \[main\]/)
  assert.match(
    source,
    /- run: pnpm install --frozen-lockfile\r?\n\s+- name: Verify Tauri JavaScript\/native versions\r?\n\s+run: pnpm verify:tauri/,
  )
})

test('repository public contracts agree end to end', async () => {
  const result = await verifyPublicContracts()
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.deepEqual(result, {
    protocol: 3,
    hostProtocol: 1,
    schema: '1.0.0',
    version: manifest.version,
    commands: { invoked: 120, registered: 124, allowed: 124 },
  })
})

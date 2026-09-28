import assert from 'node:assert/strict'
import test from 'node:test'
import { validateOfflineManifest } from './verify-offline-profile.mjs'

const valid = () => ({
  schema: 1,
  os: 'windows',
  arch: 'x86_64',
  node: { file: 'node-v22.19.0-win-x64.zip', version: 'v22.19.0' },
  harness: { file: 'harness.tar.gz', package: '@deepseek-ai/dsh', version: '0.1.7-rc.2' },
  pnpm: { version: '11.7.0' },
})

test('accepts only an offline closure matching its runner and pinned versions', () => {
  for (const [platform, os, arch, architecture] of [
    ['win32', 'windows', 'x64', 'x86_64'],
    ['linux', 'linux', 'x64', 'x86_64'],
    ['darwin', 'macos', 'arm64', 'aarch64'],
    ['darwin', 'macos', 'x64', 'x86_64'],
  ])
    assert.doesNotThrow(() =>
      validateOfflineManifest({ ...valid(), os, arch: architecture }, platform, arch),
    )
})

test('rejects missing, foreign-platform, foreign-architecture and unsupported schemas', () => {
  for (const manifest of [
    null,
    {},
    { ...valid(), os: 'linux' },
    { ...valid(), arch: 'aarch64' },
    { ...valid(), schema: 2 },
  ]) {
    assert.throws(
      () => validateOfflineManifest(manifest, 'win32', 'x64'),
      /platform does not match/,
    )
  }
  assert.throws(() => validateOfflineManifest(valid(), 'unknown', 'x64'), /platform does not match/)
  assert.throws(() => validateOfflineManifest(valid(), 'win32', 'ia32'), /platform does not match/)
})

test('rejects stale Node, Harness, pnpm and unrelated package declarations', () => {
  for (const [key, fields] of [
    ['node', { version: 'v20.0.0' }],
    ['harness', { version: '0.1.1-rc.2' }],
    ['harness', { package: '@other/runtime' }],
    ['pnpm', { version: '10.0.0' }],
  ]) {
    const manifest = valid()
    manifest[key] = { ...manifest[key], ...fields }
    assert.throws(() => validateOfflineManifest(manifest, 'win32', 'x64'), /versions do not match/)
  }
})

test('rejects archive paths escaping their verified package directory', () => {
  for (const file of [
    '',
    '..',
    '.',
    '../archive.zip',
    '..\\archive.zip',
    '/tmp/archive',
    'C:\\archive',
    'C:archive.zip',
    'bad\0name.zip',
    undefined,
  ]) {
    const manifest = valid()
    manifest.node.file = file
    assert.throws(() => validateOfflineManifest(manifest, 'win32', 'x64'), /invalid.*archive name/)
  }
})

import assert from 'node:assert/strict'
import { isAbsolute, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { connectChildPipeline, resolveBundleRoot } from './verify-packaged-app.mjs'

test('resolves the bundle root before smoke tests change their working directory', () => {
  const root = resolveBundleRoot('src-tauri/target/release/bundle')
  assert.equal(root, resolve('src-tauri/target/release/bundle'))
  assert.equal(isAbsolute(root), true)
})

test('rejects a missing bundle root', () => {
  assert.throws(() => resolveBundleRoot(), /usage:/)
})

test('connects RPM conversion output to cpio input as an explicit stream', async () => {
  const source = { stdout: new PassThrough() }
  const destination = { stdin: new PassThrough() }
  const received = []
  destination.stdin.on('data', (chunk) => received.push(chunk))
  const ended = new Promise((resolveEnded) => destination.stdin.on('end', resolveEnded))
  connectChildPipeline(source, destination)
  source.stdout.end('rpm payload')
  await ended
  assert.equal(Buffer.concat(received).toString('utf8'), 'rpm payload')
})

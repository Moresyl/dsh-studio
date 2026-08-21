import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { portableName, stagePortable } from './stage-portable.mjs'

test('portable assets have a stable installer-distinct name', () => {
  assert.equal(portableName('DSH Studio', '0.7.0'), 'DSH.Studio_0.7.0_x64-portable.exe')
})

test('portable names reject an invalid release version', () => {
  assert.throws(() => portableName('DSH Studio', 'next'))
})

test('portable staging copies the only non-empty release executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-portable-'))
  const output = join(root, 'output')
  try {
    await writeFile(join(root, 'dsh-studio.exe'), 'portable-app')
    const name = await stagePortable(root, output)

    assert.match(name, /^DSH\.Studio_\d+\.\d+\.\d+_x64-portable\.exe$/)
    assert.equal(await readFile(join(output, name), 'utf8'), 'portable-app')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('portable staging rejects ambiguous or empty executables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-portable-invalid-'))
  try {
    await assert.rejects(stagePortable(root, join(root, 'output')), /expected one/)
    await writeFile(join(root, 'empty.exe'), '')
    await assert.rejects(stagePortable(root, join(root, 'output')), /source is empty/)
    await writeFile(join(root, 'second.exe'), 'second')
    await assert.rejects(stagePortable(root, join(root, 'output')), /found 2/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

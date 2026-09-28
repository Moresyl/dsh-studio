import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { portableName, stagePortable } from './stage-portable.mjs'

test('portable assets have a stable installer-distinct name', () => {
  assert.equal(portableName('DSH Studio', '0.7.0'), 'DSH.Studio_0.7.0_x64-portable.zip')
})

test('portable names reject an invalid release version', () => {
  assert.throws(() => portableName('DSH Studio', 'next'))
})

test('portable staging includes executable, lazy chunks and fonts beside the shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-portable-'))
  const output = join(root, 'output')
  try {
    await writeFile(join(root, 'dsh-studio.exe'), 'portable-app')
    const frontend = join(root, 'frontend')
    await mkdir(join(frontend, 'assets'), { recursive: true })
    await writeFile(join(frontend, 'index.html'), 'shell')
    await writeFile(join(frontend, 'assets', 'terminal.js'), 'lazy-chunk')
    await writeFile(join(frontend, 'assets', 'font.woff2'), 'font')
    const name = await stagePortable(root, output, frontend)

    assert.match(name, /^DSH\.Studio_\d+\.\d+\.\d+_x64-portable\.zip$/)
    const contents = join(output, name.slice(0, -4))
    assert.equal(await readFile(join(contents, 'dsh-studio.exe'), 'utf8'), 'portable-app')
    assert.equal(await readFile(join(contents, 'dist', 'index.html'), 'utf8'), 'shell')
    assert.equal(
      await readFile(join(contents, 'dist', 'assets', 'terminal.js'), 'utf8'),
      'lazy-chunk',
    )
    assert.equal(await readFile(join(contents, 'dist', 'assets', 'font.woff2'), 'utf8'), 'font')
    await assert.rejects(stagePortable(root, output, frontend), /EEXIST/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('portable staging rejects a missing or incomplete frontend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-portable-missing-'))
  try {
    await writeFile(join(root, 'dsh-studio.exe'), 'portable-app')
    await assert.rejects(stagePortable(root, join(root, 'first'), join(root, 'missing')), /ENOENT/)
    const frontend = join(root, 'frontend')
    await mkdir(frontend)
    await writeFile(join(frontend, 'index.html'), 'shell')
    await assert.rejects(
      stagePortable(root, join(root, 'second'), frontend),
      /no index.html or assets/,
    )
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

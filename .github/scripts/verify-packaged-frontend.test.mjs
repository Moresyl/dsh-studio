import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyPackagedFrontend } from './verify-packaged-frontend.mjs'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-frontend-package-'))
  const expected = join(root, 'build')
  const packaged = join(root, 'package')
  const actual = join(packaged, 'resources', 'dist')
  try {
    await mkdir(join(expected, 'assets'), { recursive: true })
    await writeFile(join(expected, 'index.html'), '<script src="/assets/entry.js"></script>')
    await writeFile(join(expected, 'assets', 'entry.js'), 'entry')
    await writeFile(join(expected, 'assets', 'lazy.js'), 'lazy')
    await writeFile(join(expected, 'assets', 'font.woff2'), 'font')
    await cp(expected, actual, { recursive: true })
    await run({ root, expected, packaged, actual })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('verifies all packaged bytes including lazy chunks and fonts', async () => {
  await fixture(async ({ expected, packaged, actual }) => {
    assert.deepEqual(await verifyPackagedFrontend(packaged, expected), { files: 4, root: actual })
  })
})

test('rejects a modified entry even when its hashed-looking name is unchanged', async () => {
  await fixture(async ({ expected, packaged, actual }) => {
    await writeFile(join(actual, 'assets', 'entry.js'), 'old entry')
    await assert.rejects(verifyPackagedFrontend(packaged, expected), /differs.*assets\/entry.js/)
  })
})

test('rejects a missing lazy chunk rather than relying on a headless binary smoke', async () => {
  await fixture(async ({ expected, packaged, actual }) => {
    await rm(join(actual, 'assets', 'lazy.js'))
    await assert.rejects(verifyPackagedFrontend(packaged, expected), /missing assets\/lazy.js/)
  })
})

test('rejects stale frontend resources left by an incomplete upgrade cleanup', async () => {
  await fixture(async ({ expected, packaged, actual }) => {
    await writeFile(join(actual, 'assets', 'old-entry.js'), 'stale')
    await assert.rejects(verifyPackagedFrontend(packaged, expected), /unexpected stale resource/)
  })
})

test('rejects missing and ambiguous packaged frontend roots', async () => {
  await fixture(async ({ expected, packaged, actual }) => {
    await cp(actual, join(packaged, 'second', 'dist'), { recursive: true })
    await assert.rejects(verifyPackagedFrontend(packaged, expected), /exactly one.*found 2/)
    await rm(join(actual, 'index.html'))
    await rm(join(packaged, 'second', 'dist', 'index.html'))
    await assert.rejects(verifyPackagedFrontend(packaged, expected), /exactly one.*found 0/)
  })
})

test('rejects an incomplete expected build instead of accepting an empty package', async () => {
  await fixture(async ({ expected, packaged }) => {
    await rm(join(expected, 'index.html'))
    await assert.rejects(verifyPackagedFrontend(packaged, expected), /expected frontend build/)
  })
})

test('refuses linked resource directories instead of following them outside the package', async () => {
  await fixture(async ({ expected, packaged, actual }) => {
    await rm(join(actual, 'assets'), { recursive: true })
    await symlink(
      join(expected, 'assets'),
      join(actual, 'assets'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await assert.rejects(verifyPackagedFrontend(packaged, expected), /must not be a link/)
  })
})

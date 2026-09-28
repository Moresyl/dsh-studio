import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist')

async function filesIn(directory, strict = false) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      if (strict) throw new Error(`frontend resource must not be a link: ${entry.name}`)
      continue
    }
    if (entry.isDirectory()) files.push(...(await filesIn(path, strict)))
    else if (entry.isFile()) files.push(path)
    else if (strict) throw new Error(`frontend resource must be a regular file: ${entry.name}`)
  }
  return files
}

async function digest(file) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

async function inventory(directory) {
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('frontend resource root must be a real directory')
  }
  const files = await filesIn(directory, true)
  const entries = await Promise.all(
    files.map(async (file) => [
      relative(directory, file).replaceAll('\\', '/'),
      await digest(file),
    ]),
  )
  return new Map(entries)
}

/** Compare every shipped frontend byte, including lazy chunks and fonts. */
export async function verifyPackagedFrontend(directory, expectedDist = DEFAULT_DIST) {
  const expected = await inventory(expectedDist)
  if (
    !expected.has('index.html') ||
    ![...expected.keys()].some((name) => name.startsWith('assets/'))
  ) {
    throw new Error('expected frontend build has no index.html or assets')
  }
  const candidates = (await filesIn(directory)).filter(
    (file) => basename(file) === 'index.html' && basename(dirname(file)) === 'dist',
  )
  if (candidates.length !== 1) {
    throw new Error(`package must contain exactly one dist/index.html; found ${candidates.length}`)
  }
  const actual = await inventory(dirname(candidates[0]))
  for (const [name, hash] of expected) {
    if (!actual.has(name)) throw new Error(`packaged frontend is missing ${name}`)
    if (actual.get(name) !== hash)
      throw new Error(`packaged frontend differs from current build: ${name}`)
  }
  for (const name of actual.keys()) {
    if (!expected.has(name))
      throw new Error(`packaged frontend contains an unexpected stale resource: ${name}`)
  }
  return { files: expected.size, root: dirname(candidates[0]) }
}
